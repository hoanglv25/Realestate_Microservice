import { Deposit } from '../entities/deposit.entity';
import { SagaLog } from '../entities/saga-log.entity';
import { CompensationService } from './compensation.service';

const D = {
  id: '11111111-1111-4111-8111-111111111111',
  listingId: '22222222-2222-4222-8222-222222222222',
  tenantId: '33333333-3333-4333-8333-333333333333',
  ownerId: '44444444-4444-4444-8444-444444444444',
};
const CAUSE = {
  step: 'CREATE_PAYMENT_ORDER' as const,
  outcome: 'NOT_EXECUTED' as const,
  detail: { code: 'DEPENDENCY_UNAVAILABLE', status: 503 },
  reason: 'PAYMENT_UNAVAILABLE' as const,
};

function setup(affected = 1) {
  const steps: string[] = [];
  const m = {
    update: jest.fn(async () => {
      steps.push('update');
      return { affected };
    }),
    insert: jest.fn(async () => steps.push('saga_log')),
  };
  const dataSource = {
    transaction: jest.fn(async (cb: (mm: typeof m) => Promise<unknown>) => {
      const r = await cb(m);
      steps.push('commit');
      return r;
    }),
  };
  const outbox = { add: jest.fn(async () => steps.push('outbox')) };
  const sync = { push: jest.fn(async () => (steps.push('push'), 'SYNCED')) };
  const logger = { warn: jest.fn(), log: jest.fn() };
  const service = new CompensationService(dataSource as never, outbox as never, sync as never);
  (service as unknown as { logger: typeof logger }).logger = logger;
  return { service, m, outbox, sync, steps, logger };
}

describe('CompensationService.cancelAfterHold (RE.DEPOSIT_SAGA/Component_Class_Design.md §5)', () => {
  it('một transaction: UPDATE ... WHERE status=PENDING_PAYMENT -> CANCELLED + lý do + đích AVAILABLE; saga_log nguyên nhân; outbox deposit-cancelled; SAU commit mới đẩy AVAILABLE', async () => {
    const { service, m, outbox, sync, steps } = setup();
    expect(await service.cancelAfterHold(D, CAUSE)).toBe(true);

    expect(m.update).toHaveBeenCalledWith(
      Deposit,
      { id: D.id, status: 'PENDING_PAYMENT' },
      {
        status: 'CANCELLED',
        cancelledReason: 'PAYMENT_UNAVAILABLE',
        listingTargetStatus: 'AVAILABLE',
        listingSyncedAt: null,
      },
    );
    expect(m.insert).toHaveBeenCalledWith(
      SagaLog,
      expect.objectContaining({
        depositId: D.id,
        step: 'CREATE_PAYMENT_ORDER',
        outcome: 'NOT_EXECUTED',
        detail: CAUSE.detail,
      }),
    );
    expect(outbox.add).toHaveBeenCalledWith(m, 'rental.deposit-cancelled', {
      depositId: D.id,
      listingId: D.listingId,
      tenantId: D.tenantId,
      ownerId: D.ownerId,
    });
    expect(sync.push).toHaveBeenCalledWith({
      id: D.id,
      listingId: D.listingId,
      listingTargetStatus: 'AVAILABLE',
    });
    expect(steps).toEqual(['update', 'saga_log', 'outbox', 'commit', 'push']); // không HTTP trong transaction
  });

  it('chống đua: UPDATE 0 dòng (đơn đã đổi: PAID, EXPIRED, đã hủy) -> trả false, không saga_log, không outbox, không đẩy', async () => {
    const { service, m, outbox, sync } = setup(0);
    expect(await service.cancelAfterHold(D, CAUSE)).toBe(false);
    expect(m.insert).not.toHaveBeenCalled();
    expect(outbox.add).not.toHaveBeenCalled();
    expect(sync.push).not.toHaveBeenCalled();
  });

  it('đẩy AVAILABLE lỗi bất ngờ (DB) -> không ném (đơn đã CANCELLED), log warn; job (b) đẩy lại', async () => {
    const { service, sync, logger } = setup();
    sync.push.mockRejectedValueOnce(new Error('db down'));
    await expect(service.cancelAfterHold(D, CAUSE)).resolves.toBe(true);
    expect(logger.warn).toHaveBeenCalled();
  });
});
