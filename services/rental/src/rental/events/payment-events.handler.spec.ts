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

  it('chỉ đăng ký payment.deposited (sự kiện khác của payment thuộc RE.DEPOSIT_LIFECYCLE)', () => {
    const { registry } = setup();
    expect(registry.on.mock.calls.map(([t]) => t)).toEqual(['payment.deposited']);
  });
});
