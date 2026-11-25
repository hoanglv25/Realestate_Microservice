import { HttpStatus } from '@nestjs/common';
import { LessThan } from 'typeorm';
import { AppException } from '../../common/errors/app.exception';
import { Deposit } from '../entities/deposit.entity';
import { SagaLog } from '../entities/saga-log.entity';
import { HoldExpiryJob } from './hold-expiry.job';

const NOW = new Date('2026-11-25T08:00:00.000Z');
const due = (n: number) => ({
  id: `0000000${n}-0000-4000-8000-000000000000`,
  listingId: `1000000${n}-0000-4000-8000-000000000000`,
  tenantId: '33333333-3333-4333-8333-333333333333',
  ownerId: '44444444-4444-4444-8444-444444444444',
  status: 'PENDING_PAYMENT',
  expiresAt: new Date(NOW.getTime() - 1000),
});
const paymentError = (status: HttpStatus, code: string, details?: Record<string, unknown>) =>
  new AppException(code, code, status, details);

function setup(opts: { due?: unknown[]; intervalMs?: number } = {}) {
  const calls: string[] = [];
  const deposits = { find: jest.fn().mockResolvedValue(opts.due ?? [due(1)]) };
  const m = {
    update: jest.fn().mockResolvedValue({ affected: 1 }),
    insert: jest.fn().mockResolvedValue({}),
  };
  const dataSource = {
    transaction: jest.fn(async (cb: (mm: typeof m) => Promise<unknown>) => {
      calls.push('transaction');
      return cb(m);
    }),
  };
  const payment = {
    cancelOrder: jest.fn(async (id: string) => {
      calls.push(`cancel:${id}`);
      return { status: 'CANCELLED' };
    }),
  };
  const outbox = { add: jest.fn().mockResolvedValue(undefined) };
  const sync = {
    push: jest.fn(async (d: { id: string }) => {
      calls.push(`push:${d.id}`);
      return 'SYNCED';
    }),
  };
  const scheduler = {
    addInterval: jest.fn(),
    deleteInterval: jest.fn(),
    doesExist: jest.fn().mockReturnValue(true),
  };
  const logger = { warn: jest.fn(), log: jest.fn() };
  const job = new HoldExpiryJob(
    deposits as never,
    dataSource as never,
    payment as never,
    outbox as never,
    sync as never,
    scheduler as never,
    { intervalMs: opts.intervalMs ?? 5000 },
  );
  (job as unknown as { logger: typeof logger }).logger = logger;
  return { job, calls, deposits, m, dataSource, payment, outbox, sync, scheduler, logger };
}

beforeAll(() => jest.useFakeTimers({ now: NOW, doNotFake: ['nextTick', 'setImmediate'] }));
afterAll(() => jest.useRealTimers());

describe('HoldExpiryJob (RE.DEPOSIT_SAGA/Component_Class_Design.md §7, BR-09)', () => {
  it('chọn PENDING_PAYMENT quá expires_at, hết hạn sớm nhất trước, tối đa 50', async () => {
    const { job, deposits } = setup({ due: [] });
    await job.runOnce();
    expect(deposits.find).toHaveBeenCalledWith({
      where: { status: 'PENDING_PAYMENT', expiresAt: LessThan(NOW) },
      order: { expiresAt: 'ASC' },
      take: 50,
    });
  });

  it('test 11 (E4): hủy order 200 -> HỦY LINK TRƯỚC, rồi một transaction EXPIRED + đích AVAILABLE + saga_log + outbox deposit-expired, rồi đẩy AVAILABLE', async () => {
    const d = due(1);
    const { job, calls, m, outbox, sync } = setup({ due: [d] });

    await expect(job.runOnce()).resolves.toMatchObject({ expired: 1 });

    expect(calls).toEqual([`cancel:${d.id}`, 'transaction', `push:${d.id}`]);
    expect(m.update).toHaveBeenCalledWith(
      Deposit,
      { id: d.id, status: 'PENDING_PAYMENT' },
      { status: 'EXPIRED', listingTargetStatus: 'AVAILABLE', listingSyncedAt: null },
    );
    expect(m.insert).toHaveBeenCalledWith(
      SagaLog,
      expect.objectContaining({
        depositId: d.id,
        step: 'CANCEL_PAYMENT_ORDER',
        outcome: 'OK',
        detail: { status: 200 },
      }),
    );
    expect(outbox.add).toHaveBeenCalledWith(m, 'rental.deposit-expired', {
      depositId: d.id,
      listingId: d.listingId,
      tenantId: d.tenantId,
      ownerId: d.ownerId,
    });
    expect(sync.push).toHaveBeenCalledWith({
      id: d.id,
      listingId: d.listingId,
      listingTargetStatus: 'AVAILABLE',
    });
  });

  it('hủy order 404 PAYMENT_ORDER_NOT_FOUND (payment chưa có order) -> vẫn EXPIRED, saga_log ghi status 404', async () => {
    const { job, payment, m, outbox, sync } = setup();
    payment.cancelOrder.mockRejectedValueOnce(
      paymentError(HttpStatus.NOT_FOUND, 'PAYMENT_ORDER_NOT_FOUND'),
    );

    await expect(job.runOnce()).resolves.toMatchObject({ expired: 1 });
    expect(m.insert).toHaveBeenCalledWith(
      SagaLog,
      expect.objectContaining({ step: 'CANCEL_PAYMENT_ORDER', detail: { status: 404 } }),
    );
    expect(outbox.add).toHaveBeenCalledTimes(1);
    expect(sync.push).toHaveBeenCalledTimes(1);
  });

  it('test 12 (B3): 409 PAYMENT_ORDER_ALREADY_PAID (webhook thắng) -> không EXPIRED, không đẩy listing, chỉ log info (chờ payment.deposited)', async () => {
    const { job, payment, dataSource, sync, logger } = setup();
    payment.cancelOrder.mockRejectedValueOnce(
      paymentError(HttpStatus.CONFLICT, 'PAYMENT_ORDER_ALREADY_PAID'),
    );

    await expect(job.runOnce()).resolves.toMatchObject({ expired: 0, paid: 1 });
    expect(dataSource.transaction).not.toHaveBeenCalled();
    expect(sync.push).not.toHaveBeenCalled();
    expect(logger.log).toHaveBeenCalled();
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it.each([
    [
      '503 PAYMENT_PROVIDER_UNAVAILABLE (payOS lỗi)',
      () => paymentError(HttpStatus.SERVICE_UNAVAILABLE, 'PAYMENT_PROVIDER_UNAVAILABLE'),
    ],
    [
      '504 (timeout, UNKNOWN)',
      () => paymentError(HttpStatus.GATEWAY_TIMEOUT, 'DEPENDENCY_TIMEOUT'),
    ],
    [
      '503 NOT_EXECUTED (payment dừng)',
      () =>
        paymentError(HttpStatus.SERVICE_UNAVAILABLE, 'DEPENDENCY_UNAVAILABLE', {
          outcome: 'NOT_EXECUTED',
        }),
    ],
    ['4xx lạ (400)', () => paymentError(HttpStatus.BAD_REQUEST, 'VALIDATION_FAILED')],
    ['lỗi không phải HTTP', () => new Error('socket hang up')],
  ])(
    'test 13 (B4): %s -> giữ PENDING_PAYMENT (chưa chắc link đã hủy thì không nhả chỗ), log warn; đơn sau vẫn được xử lý',
    async (_name, makeErr) => {
      const d1 = due(1);
      const d2 = due(2);
      const { job, payment, m, sync, logger } = setup({ due: [d1, d2] });
      payment.cancelOrder.mockRejectedValueOnce(makeErr());

      await expect(job.runOnce()).resolves.toMatchObject({ expired: 1, retry: 1 });
      expect(m.update).toHaveBeenCalledTimes(1);
      expect(m.update).toHaveBeenCalledWith(
        Deposit,
        { id: d2.id, status: 'PENDING_PAYMENT' },
        expect.anything(),
      );
      expect(sync.push).toHaveBeenCalledTimes(1);
      expect(sync.push).toHaveBeenCalledWith(expect.objectContaining({ id: d2.id }));
      expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining(d1.id));
    },
  );

  it('B7: UPDATE 0 dòng (đơn vừa PAID/CANCELLED giữa lúc hủy link) -> dừng: không saga_log, không outbox, không đẩy listing', async () => {
    const { job, m, outbox, sync } = setup();
    m.update.mockResolvedValueOnce({ affected: 0 });

    await expect(job.runOnce()).resolves.toMatchObject({ expired: 0, skipped: 1 });
    expect(m.insert).not.toHaveBeenCalled();
    expect(outbox.add).not.toHaveBeenCalled();
    expect(sync.push).not.toHaveBeenCalled();
  });

  it('transaction lỗi (DB) -> đơn đó tính failed, log warn; đơn sau vẫn được xử lý', async () => {
    const d1 = due(1);
    const d2 = due(2);
    const { job, dataSource, sync, logger } = setup({ due: [d1, d2] });
    dataSource.transaction.mockRejectedValueOnce(new Error('db down'));

    await expect(job.runOnce()).resolves.toMatchObject({ expired: 1, failed: 1 });
    expect(sync.push).toHaveBeenCalledTimes(1);
    expect(sync.push).toHaveBeenCalledWith(expect.objectContaining({ id: d2.id }));
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining(d1.id));
  });

  it('đẩy listing ném lỗi sau khi đã EXPIRED -> đơn vẫn EXPIRED, log warn; đích AVAILABLE còn trong DB cho SagaReconcileJob (b)', async () => {
    const d1 = due(1);
    const d2 = due(2);
    const { job, sync, logger } = setup({ due: [d1, d2] });
    sync.push.mockRejectedValueOnce(new Error('db down'));

    await expect(job.runOnce()).resolves.toMatchObject({ expired: 2 });
    expect(sync.push).toHaveBeenCalledTimes(2);
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining(d1.id));
  });

  it('B1: đăng ký interval "hold-expiry" theo HOLD_EXPIRY_INTERVAL_MS; 0 -> không đăng ký', () => {
    const on = setup({ intervalMs: 5000 });
    on.job.onApplicationBootstrap();
    expect(on.scheduler.addInterval).toHaveBeenCalledWith('hold-expiry', expect.anything());
    clearInterval(on.scheduler.addInterval.mock.calls[0][1] as NodeJS.Timeout);

    const off = setup({ intervalMs: 0 });
    off.job.onApplicationBootstrap();
    expect(off.scheduler.addInterval).not.toHaveBeenCalled();
  });
});
