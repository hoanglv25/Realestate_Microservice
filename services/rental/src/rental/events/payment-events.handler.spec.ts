import { IsNull } from 'typeorm';
import { PaymentEventsHandler } from './payment-events.handler';

const DEPOSIT = '3f9a1c2e-8b4d-4e6f-a1b2-c3d4e5f60718';
const TENANT = '7c1e2d34-5b6a-4f70-9e81-2a3b4c5d6e7f';
const LISTING = '33333333-3333-4333-8333-333333333333';
const PAID_AT = '2026-11-20T08:05:12.000Z';
const event = {
  eventId: 'e1',
  eventType: 'payment.deposited',
  occurredAt: PAID_AT,
  producer: 'payment',
  version: 1,
  correlationId: 'c1',
  payload: {
    depositId: DEPOSIT,
    orderId: 'o1',
    tenantId: TENANT,
    ownerId: 'b2c3d4e5-f6a7-4b8c-9d0e-1f2a3b4c5d6e',
    amountVnd: 3000000,
    payosReference: 'FT123',
    paidAt: PAID_AT,
  },
};

function setup(affected = 1) {
  const registry = { on: jest.fn() };
  const viewings = { cancelOthersOnDeposit: jest.fn().mockResolvedValue(2) };
  const m = {
    update: jest.fn().mockResolvedValue({ affected }),
    findOneByOrFail: jest
      .fn()
      .mockResolvedValue({ id: DEPOSIT, listingId: LISTING, tenantId: TENANT }),
  };
  const handler = new PaymentEventsHandler(registry as never, viewings as never, {
    refundWindowSeconds: 172800,
    autoReleaseSeconds: 259200,
  });
  handler.onModuleInit();
  const run = registry.on.mock.calls.find(([type]) => type === 'payment.deposited')![1] as (
    e: unknown,
    m: unknown,
  ) => Promise<void>;
  return { run: () => run(event, m), m, viewings, registry };
}

describe('PaymentEventsHandler: payment.deposited (RE.DEPOSIT_SAGA §6)', () => {
  it('test 14: PENDING_PAYMENT -> PAID, mốc 48h/72h từ paidAt, đích listing DEPOSITED; hủy lịch xem của người khác cùng manager', async () => {
    const { run, m, viewings } = setup();
    await run();

    const [entity, where, set] = m.update.mock.calls[0];
    expect(entity.name).toBe('Deposit');
    expect(where).toEqual({ id: DEPOSIT, status: 'PENDING_PAYMENT' });
    expect(set).toEqual({
      status: 'PAID',
      paidAt: new Date(PAID_AT),
      refundDeadlineAt: new Date(Date.parse(PAID_AT) + 172800 * 1000),
      autoReleaseAt: new Date(Date.parse(PAID_AT) + 259200 * 1000),
      listingTargetStatus: 'DEPOSITED',
      listingSyncedAt: null,
    });
    expect(viewings.cancelOthersOnDeposit).toHaveBeenCalledWith(m, LISTING, TENANT);
  });

  it('test 15, 16: UPDATE 0 dòng (đã PAID, hoặc EXPIRED: tiền đến muộn do payment xử lý) -> không đổi gì, không hủy lịch xem', async () => {
    const { run, m, viewings } = setup(0);
    await run();
    expect(m.findOneByOrFail).not.toHaveBeenCalled();
    expect(viewings.cancelOthersOnDeposit).not.toHaveBeenCalled();
  });

  it('đăng ký đúng 4 khóa đã bind vào rental.payment-events (không withdrawal-requested/failed, C10)', () => {
    const { registry } = setup();
    expect(registry.on.mock.calls.map(([t]) => t)).toEqual([
      'payment.deposited',
      'payment.refunded',
      'payment.refund-rejected',
      'payment.withdrawal-completed',
    ]);
  });
});

describe('PaymentEventsHandler: vòng đời đơn (RE.DEPOSIT_LIFECYCLE §4, T3.5)', () => {
  const OCCURRED = '2026-11-25T09:00:00.000Z';
  const ev = (eventType: string, payload: Record<string, unknown>) => ({
    ...event,
    eventId: `e-${eventType}`,
    eventType,
    occurredAt: OCCURRED,
    payload: { depositId: DEPOSIT, tenantId: TENANT, ownerId: 'o', ...payload },
  });
  function setupLifecycle(affected: number[] = [1]) {
    const registry = { on: jest.fn() };
    const m = { update: jest.fn() };
    for (const a of affected) m.update.mockResolvedValueOnce({ affected: a });
    const handler = new PaymentEventsHandler(registry as never, {} as never, {
      refundWindowSeconds: 172800,
      autoReleaseSeconds: 259200,
    });
    const logger = { warn: jest.fn(), log: jest.fn() };
    (handler as unknown as { logger: typeof logger }).logger = logger;
    handler.onModuleInit();
    const run = (type: string, e: unknown) =>
      (
        registry.on.mock.calls.find(([t]) => t === type)![1] as (
          e: unknown,
          m: unknown,
        ) => Promise<void>
      )(e, m);
    return { run, m, logger };
  }

  it('test 6: payment.refunded TENANT -> REFUND_REQUESTED → REFUNDED, refunded_at, đích listing AVAILABLE (job (b) đẩy)', async () => {
    const { run, m } = setupLifecycle();
    await run(
      'payment.refunded',
      ev('payment.refunded', { requesterType: 'TENANT', amountVnd: 2100000 }),
    );
    expect(m.update).toHaveBeenCalledTimes(1);
    const [entity, where, set] = m.update.mock.calls[0];
    expect(entity.name).toBe('Deposit');
    expect(where).toEqual({ id: DEPOSIT, status: 'REFUND_REQUESTED' });
    expect(set).toEqual({
      status: 'REFUNDED',
      refundedAt: new Date(OCCURRED),
      listingTargetStatus: 'AVAILABLE',
      listingSyncedAt: null,
    });
  });

  it('test 7: payment.refunded SYSTEM (tiền đến muộn, đơn EXPIRED) -> không đổi, log info', async () => {
    const { run, m, logger } = setupLifecycle();
    await run('payment.refunded', ev('payment.refunded', { requesterType: 'SYSTEM' }));
    expect(m.update).not.toHaveBeenCalled();
    expect(logger.log).toHaveBeenCalled();
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('payment.refunded TENANT nhưng đơn không REFUND_REQUESTED (sai thứ tự, trùng) -> 0 dòng, log warn', async () => {
    const { run, logger } = setupLifecycle([0]);
    await run('payment.refunded', ev('payment.refunded', { requesterType: 'TENANT' }));
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining(DEPOSIT));
  });

  it('test 8: payment.refund-rejected -> REFUND_REQUESTED → PAID (mốc 72 giờ giữ nguyên: quá rồi thì AutoReleaseJob giải ngân lượt sau)', async () => {
    const { run, m } = setupLifecycle();
    await run(
      'payment.refund-rejected',
      ev('payment.refund-rejected', { reason: 'Đã nhận phòng' }),
    );
    expect(m.update.mock.calls[0].slice(1)).toEqual([
      { id: DEPOSIT, status: 'REFUND_REQUESTED' },
      { status: 'PAID' },
    ]);
  });

  it('payment.refund-rejected khi đơn không REFUND_REQUESTED -> log warn', async () => {
    const { run, logger } = setupLifecycle([0]);
    await run('payment.refund-rejected', ev('payment.refund-rejected', { reason: 'x' }));
    expect(logger.warn).toHaveBeenCalled();
  });

  it('test 14: payment.withdrawal-completed đơn RELEASED -> WITHDRAWN, withdrawn_at', async () => {
    const { run, m } = setupLifecycle([1]);
    await run(
      'payment.withdrawal-completed',
      ev('payment.withdrawal-completed', { withdrawalId: 'w1', amountVnd: 1 }),
    );
    expect(m.update).toHaveBeenCalledTimes(1);
    expect(m.update.mock.calls[0].slice(1)).toEqual([
      { id: DEPOSIT, status: 'RELEASED' },
      { status: 'WITHDRAWN', withdrawnAt: new Date(OCCURRED) },
    ]);
  });

  it('test 14: payment.withdrawal-completed đơn REFUNDED -> giữ REFUNDED, chỉ đặt withdrawn_at nếu còn trống (BR-15 sửa)', async () => {
    const { run, m, logger } = setupLifecycle([0, 1]);
    await run(
      'payment.withdrawal-completed',
      ev('payment.withdrawal-completed', { withdrawalId: 'w1', amountVnd: 1 }),
    );
    const [, where, set] = m.update.mock.calls[1];
    expect(where).toEqual({ id: DEPOSIT, status: 'REFUNDED', withdrawnAt: IsNull() });
    expect(set).toEqual({ withdrawnAt: new Date(OCCURRED) });
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('payment.withdrawal-completed đơn trạng thái khác (hoặc đã ghi) -> log warn, không đổi', async () => {
    const { run, m, logger } = setupLifecycle([0, 0]);
    await run(
      'payment.withdrawal-completed',
      ev('payment.withdrawal-completed', { withdrawalId: 'w1', amountVnd: 1 }),
    );
    expect(m.update).toHaveBeenCalledTimes(2);
    expect(logger.warn).toHaveBeenCalled();
  });
});
