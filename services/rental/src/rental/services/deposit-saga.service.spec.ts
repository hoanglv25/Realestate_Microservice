import { QueryFailedError } from 'typeorm';
import { AppException } from '../../common/errors/app.exception';
import { RentalError } from '../errors/rental.errors';
import { DepositSagaService } from './deposit-saga.service';

const TENANT = '11111111-1111-4111-8111-111111111111';
const OWNER = '22222222-2222-4222-8222-222222222222';
const LISTING = '33333333-3333-4333-8333-333333333333';
const SNAPSHOT = {
  id: LISTING,
  ownerId: OWNER,
  title: 'Phòng 25m2',
  depositAmountVnd: 3_000_000,
  status: 'AVAILABLE',
  approvalStatus: 'APPROVED',
};
const ORDER = {
  orderId: '55555555-5555-4555-8555-555555555555',
  payosOrderCode: 100001,
  checkoutUrl: 'https://pay.payos.vn/web/x',
  qrCode: '000201',
  expiresAt: '2026-11-20T08:10:00.000Z',
};
const HOLD_TTL = 600;

function setup() {
  const calls: string[] = [];
  const track = <T>(name: string, value: T) =>
    jest.fn(async (..._args: unknown[]) => {
      calls.push(name);
      return value;
    });
  const lock = { acquire: track('lock.acquire', 'tok'), release: track('lock.release', undefined) };
  const listing = {
    getSnapshot: track('listing.snapshot', SNAPSHOT),
    hold: track('listing.hold', { status: 'HELD' }),
    changeStatus: track('listing.release', {}),
  };
  const payment = { createOrder: track('payment.createOrder', ORDER) };
  const outbox = { add: track('outbox', {}) };
  const manager = {
    insert: jest.fn(async (entity: { name: string }, _data?: unknown) => {
      calls.push(`insert:${entity.name}`);
      return {};
    }),
    update: jest.fn(async (entity: { name: string }, _where?: unknown, _set?: unknown) => {
      calls.push(`update:${entity.name}`);
      return { affected: 1 };
    }),
  };
  const dataSource = { transaction: jest.fn(async (cb: (m: unknown) => unknown) => cb(manager)) };
  const sagaLogs = { insert: track('sagaLog.insert', {}) };
  const service = new DepositSagaService(
    dataSource as never,
    sagaLogs as never,
    lock as never,
    listing as never,
    payment as never,
    outbox as never,
    { holdTtlSeconds: HOLD_TTL },
  );
  return { service, calls, lock, listing, payment, outbox, manager, sagaLogs, dataSource };
}

const codeOf = (p: Promise<unknown>) =>
  p.then(
    () => 'khong-loi',
    (e: { code?: string }) => e.code,
  );

describe('DepositSagaService.start: luồng thành công (test 1, 2)', () => {
  it('thứ tự: khóa → snapshot → giữ chỗ → [đơn + saga_log + outbox] → tạo order → [lưu order + saga_log] → nhả khóa', async () => {
    const { service, calls } = setup();
    await service.start(TENANT, LISTING);
    expect(calls).toEqual([
      'lock.acquire',
      'listing.snapshot',
      'listing.hold',
      'insert:Deposit',
      'insert:SagaLog',
      'outbox',
      'payment.createOrder',
      'update:Deposit',
      'insert:SagaLog',
      'lock.release',
    ]);
  });

  it('test 2: số tiền, chủ tin, tiêu đề lấy từ bản chụp (BR-04); depositId gửi listing = id đơn; hạn = now + HOLD_TTL', async () => {
    const { service, listing, manager, payment, outbox } = setup();
    const before = Date.now();
    const result = await service.start(TENANT, LISTING);

    const [, depositId, heldUntil] = listing.hold.mock.calls[0] as [string, string, Date];
    expect(heldUntil.getTime() - before).toBeGreaterThanOrEqual(HOLD_TTL * 1000 - 50);
    expect(heldUntil.getTime() - Date.now()).toBeLessThanOrEqual(HOLD_TTL * 1000);
    const deposit = manager.insert.mock.calls[0][1];
    expect(deposit).toEqual({
      id: depositId,
      listingId: LISTING,
      tenantId: TENANT,
      ownerId: OWNER,
      listingTitle: 'Phòng 25m2',
      amountVnd: 3_000_000,
      status: 'PENDING_PAYMENT',
      expiresAt: heldUntil,
    });
    expect(manager.insert.mock.calls[1][1]).toMatchObject({
      depositId,
      step: 'HOLD_LISTING',
      outcome: 'OK',
    });
    expect(outbox.add).toHaveBeenCalledWith(manager, 'rental.deposit-created', {
      depositId,
      listingId: LISTING,
      tenantId: TENANT,
      ownerId: OWNER,
      amountVnd: 3_000_000,
      expiresAt: heldUntil.toISOString(),
    });
    expect(payment.createOrder).toHaveBeenCalledWith({
      depositId,
      tenantId: TENANT,
      ownerId: OWNER,
      listingTitle: 'Phòng 25m2',
      amountVnd: 3_000_000,
      expiresAt: heldUntil,
    });
    expect(manager.update.mock.calls[0].slice(1)).toEqual([
      { id: depositId },
      { paymentOrderId: ORDER.orderId, checkoutUrl: ORDER.checkoutUrl, qrCode: ORDER.qrCode },
    ]);
    expect(manager.insert.mock.calls[2][1]).toMatchObject({
      step: 'CREATE_PAYMENT_ORDER',
      outcome: 'OK',
    });
    expect(result).toMatchObject({
      depositId,
      status: 'PENDING_PAYMENT',
      listingId: LISTING,
      amountVnd: 3_000_000,
      expiresAt: heldUntil.toISOString(),
      checkoutUrl: ORDER.checkoutUrl,
      qrCode: ORDER.qrCode,
    });
    expect(result.holdRemainingSeconds).toBeGreaterThan(HOLD_TTL - 5);
    expect(result.holdRemainingSeconds).toBeLessThanOrEqual(HOLD_TTL);
  });
});

describe('DepositSagaService.start: lỗi trước khi có đơn (Processing_Flow §3)', () => {
  it.each([
    ['chưa duyệt', { approvalStatus: 'PENDING_REVIEW' }],
    ['đang HELD', { status: 'HELD' }],
    ['HIDDEN', { status: 'HIDDEN' }],
  ])('bản chụp %s -> 409 LISTING_NOT_AVAILABLE, không giữ chỗ, vẫn nhả khóa', async (_, over) => {
    const { service, listing, lock } = setup();
    listing.getSnapshot.mockResolvedValueOnce({ ...SNAPSHOT, ...over });
    expect(await codeOf(service.start(TENANT, LISTING))).toBe(RentalError.LISTING_NOT_AVAILABLE);
    expect(listing.hold).not.toHaveBeenCalled();
    expect(lock.release).toHaveBeenCalledWith(LISTING, 'tok');
  });

  it('khóa đang bị giữ -> lỗi khóa, không gọi listing', async () => {
    const { service, lock, listing } = setup();
    lock.acquire.mockRejectedValueOnce(new AppException('RENTAL_DEPOSIT_IN_PROGRESS', 'x', 409));
    expect(await codeOf(service.start(TENANT, LISTING))).toBe('RENTAL_DEPOSIT_IN_PROGRESS');
    expect(listing.getSnapshot).not.toHaveBeenCalled();
    expect(lock.release).not.toHaveBeenCalled();
  });

  it.each([
    ['409', new AppException('LISTING_NOT_AVAILABLE', 'x', 409)],
    ['503', new AppException('UPSTREAM_UNAVAILABLE', 'x', 503, { outcome: 'NOT_EXECUTED' })],
    ['504', new AppException('UPSTREAM_TIMEOUT', 'x', 504, { outcome: 'UNKNOWN' })],
  ])('giữ chỗ lỗi %s -> chuyển nguyên, không có đơn, không gọi payment', async (_, err) => {
    const { service, listing, manager, payment } = setup();
    listing.hold.mockRejectedValueOnce(err);
    expect(await codeOf(service.start(TENANT, LISTING))).toBe(err.code);
    expect(manager.insert).not.toHaveBeenCalled();
    expect(payment.createOrder).not.toHaveBeenCalled();
  });

  it('test 18 (lớp 3): ux_deposits_active_listing -> nhả chỗ best-effort, 409 LISTING_NOT_AVAILABLE', async () => {
    const { service, dataSource, listing, payment } = setup();
    dataSource.transaction.mockRejectedValueOnce(
      new QueryFailedError(
        'INSERT',
        [],
        Object.assign(new Error('dup'), {
          code: '23505',
          constraint: 'ux_deposits_active_listing',
        }),
      ),
    );
    expect(await codeOf(service.start(TENANT, LISTING))).toBe(RentalError.LISTING_NOT_AVAILABLE);
    const [listingId, depositId, status] = listing.changeStatus.mock.calls[0] as string[];
    expect([listingId, status]).toEqual([LISTING, 'AVAILABLE']);
    expect(depositId).toBe((listing.hold.mock.calls[0] as string[])[1]);
    expect(payment.createOrder).not.toHaveBeenCalled();
  });

  it('ghi đơn lỗi DB khác -> nhả chỗ best-effort (kể cả khi nhả cũng lỗi), ném lỗi gốc (500)', async () => {
    const { service, dataSource, listing } = setup();
    const boom = new Error('db down');
    dataSource.transaction.mockRejectedValueOnce(boom);
    listing.changeStatus.mockRejectedValueOnce(new Error('listing down'));
    await expect(service.start(TENANT, LISTING)).rejects.toBe(boom);
    expect(listing.changeStatus).toHaveBeenCalledTimes(1);
  });
});

describe('DepositSagaService.start: tạo order lỗi (bù trừ là T3.3)', () => {
  it.each([
    ['4xx', new AppException('PAYMENT_ORDER_EXPIRED', 'x', 409), 'BUSINESS_ERROR'],
    [
      '503 chưa gửi',
      new AppException('UPSTREAM_UNAVAILABLE', 'x', 503, { outcome: 'NOT_EXECUTED' }),
      'NOT_EXECUTED',
    ],
    ['504', new AppException('UPSTREAM_TIMEOUT', 'x', 504, { outcome: 'UNKNOWN' }), 'UNKNOWN'],
  ])(
    '%s -> saga_log CREATE_PAYMENT_ORDER %s (detail mã lỗi), ném nguyên lỗi, nhả khóa',
    async (_, err, outcome) => {
      const { service, payment, sagaLogs, lock, manager } = setup();
      payment.createOrder.mockRejectedValueOnce(err);
      expect(await codeOf(service.start(TENANT, LISTING))).toBe(err.code);
      expect(sagaLogs.insert).toHaveBeenCalledWith(
        expect.objectContaining({
          step: 'CREATE_PAYMENT_ORDER',
          outcome,
          detail: { code: err.code, status: err.getStatus() },
        }),
      );
      expect(manager.update).not.toHaveBeenCalled();
      expect(lock.release).toHaveBeenCalled();
    },
  );
});
