import { HttpStatus } from '@nestjs/common';
import { IsNull } from 'typeorm';
import { AppException } from '../../common/errors/app.exception';
import { Deposit } from '../entities/deposit.entity';
import { SagaLog } from '../entities/saga-log.entity';
import { ListingSyncService } from './listing-sync.service';

const D = {
  id: '11111111-1111-4111-8111-111111111111',
  listingId: '22222222-2222-4222-8222-222222222222',
  listingTargetStatus: 'AVAILABLE' as const,
};

const unavailable = (outcome?: 'NOT_EXECUTED') =>
  new AppException(
    'DEPENDENCY_UNAVAILABLE',
    'listing không phản hồi',
    HttpStatus.SERVICE_UNAVAILABLE,
    outcome ? { outcome } : undefined,
  );

function setup() {
  const listing = { changeStatus: jest.fn().mockResolvedValue({}) };
  const m = {
    update: jest.fn().mockResolvedValue({ affected: 1 }),
    insert: jest.fn().mockResolvedValue({}),
  };
  const deposits = { update: jest.fn().mockResolvedValue({ affected: 1 }) };
  const dataSource = {
    transaction: jest.fn(async (cb: (mm: typeof m) => Promise<unknown>) => cb(m)),
  };
  const logger = { warn: jest.fn(), log: jest.fn() };
  const service = new ListingSyncService(listing as never, deposits as never, dataSource as never);
  (service as unknown as { logger: typeof logger }).logger = logger;
  return { service, listing, deposits, dataSource, m, logger };
}

describe('ListingSyncService.push (RE.DEPOSIT_SAGA §5, §7 job (b); C20)', () => {
  it('đẩy đích sang listing; thành công -> đánh dấu listing_synced_at CHỈ khi đích không đổi và chưa đánh dấu (B7); 1 truy vấn', async () => {
    const { service, listing, deposits, dataSource } = setup();
    expect(await service.push(D)).toBe('SYNCED');
    expect(listing.changeStatus).toHaveBeenCalledWith(D.listingId, D.id, 'AVAILABLE');
    expect(deposits.update).toHaveBeenCalledWith(
      { id: D.id, listingTargetStatus: 'AVAILABLE', listingSyncedAt: IsNull() },
      { listingSyncedAt: expect.any(Function) },
    );
    expect(dataSource.transaction).not.toHaveBeenCalled(); // thành công không ghi saga_log (B2)
  });

  it('DEPOSITED (sau payment.deposited) đẩy đúng đích', async () => {
    const { service, listing } = setup();
    await service.push({ ...D, listingTargetStatus: 'DEPOSITED' });
    expect(listing.changeStatus).toHaveBeenCalledWith(D.listingId, D.id, 'DEPOSITED');
  });

  it('không có đích -> bỏ qua, không gọi listing', async () => {
    const { service, listing } = setup();
    expect(await service.push({ ...D, listingTargetStatus: null })).toBe('SKIPPED');
    expect(listing.changeStatus).not.toHaveBeenCalled();
  });

  it('C20: 409 LISTING_INVALID_STATUS -> KẾT CỤC CUỐI: đánh dấu đã đồng bộ + saga_log SYNC_LISTING BUSINESS_ERROR kèm details, cùng transaction; log warn', async () => {
    const { service, listing, m, logger } = setup();
    listing.changeStatus.mockRejectedValue(
      new AppException('LISTING_INVALID_STATUS', 'Tin thuộc đơn khác', HttpStatus.CONFLICT, {
        current: 'HELD',
        target: 'AVAILABLE',
      }),
    );
    expect(await service.push(D)).toBe('REJECTED');
    expect(m.update).toHaveBeenCalledWith(
      Deposit,
      { id: D.id, listingTargetStatus: 'AVAILABLE', listingSyncedAt: IsNull() },
      { listingSyncedAt: expect.any(Function) },
    );
    expect(m.insert).toHaveBeenCalledWith(
      SagaLog,
      expect.objectContaining({
        depositId: D.id,
        step: 'SYNC_LISTING',
        outcome: 'BUSINESS_ERROR',
        detail: {
          code: 'LISTING_INVALID_STATUS',
          status: 409,
          details: { current: 'HELD', target: 'AVAILABLE' },
        },
      }),
    );
    expect(logger.warn).toHaveBeenCalled();
  });

  it('B1: 4xx khác (404 LISTING_NOT_FOUND) cũng là kết cục cuối', async () => {
    const { service, listing, m } = setup();
    listing.changeStatus.mockRejectedValue(
      new AppException('LISTING_NOT_FOUND', 'Không có', HttpStatus.NOT_FOUND),
    );
    expect(await service.push(D)).toBe('REJECTED');
    expect(m.insert).toHaveBeenCalled();
  });

  it.each([
    ['503 không gửi được (NOT_EXECUTED)', unavailable('NOT_EXECUTED')],
    ['503/504 không rõ (UNKNOWN)', unavailable()],
    ['lỗi lạ', new Error('socket hang up')],
  ])(
    'test 17: %s -> RETRY: KHÔNG đánh dấu, KHÔNG ghi saga_log (B2), log warn; lượt job sau đẩy lại',
    async (_, err) => {
      const { service, listing, deposits, dataSource, logger } = setup();
      listing.changeStatus.mockRejectedValue(err);
      expect(await service.push(D)).toBe('RETRY');
      expect(deposits.update).not.toHaveBeenCalled();
      expect(dataSource.transaction).not.toHaveBeenCalled();
      expect(logger.warn).toHaveBeenCalled();
    },
  );
});
