import { AppException } from '../../common/errors/app.exception';
import { classifyCall } from './call-outcome';
import { ListingClient } from './listing.client';
import { PaymentClient } from './payment.client';

const URLS = { listing: 'http://listing:3002', payment: 'http://payment:3004' };
const TIMEOUTS = { listingMs: 2000, paymentMs: 3000 };

function setup() {
  const http = {
    get: jest.fn().mockResolvedValue({ ok: true }),
    post: jest.fn().mockResolvedValue({ ok: true }),
    put: jest.fn().mockResolvedValue({ ok: true }),
  };
  const config = { urls: URLS, timeouts: TIMEOUTS };
  return {
    http,
    listing: new ListingClient(http as never, config),
    payment: new PaymentClient(http as never, config),
  };
}

describe('ListingClient', () => {
  it('getSnapshot: GET /internal/listings/:id, timeout LISTING_CALL_TIMEOUT_MS (GET được retry mặc định)', async () => {
    const { http, listing } = setup();
    await listing.getSnapshot('L1');
    expect(http.get).toHaveBeenCalledWith('http://listing:3002/internal/listings/L1', {
      timeoutMs: 2000,
    });
  });

  it('hold: POST /holds {depositId, heldUntil ISO}, KHÔNG idempotent (không retry, RE.DEPOSIT_SAGA §2)', async () => {
    const { http, listing } = setup();
    const heldUntil = new Date('2026-11-20T08:10:00.000Z');
    await listing.hold('L1', 'D1', heldUntil);
    expect(http.post).toHaveBeenCalledWith(
      'http://listing:3002/internal/listings/L1/holds',
      { depositId: 'D1', heldUntil: '2026-11-20T08:10:00.000Z' },
      { timeoutMs: 2000 },
    );
  });

  it('changeStatus: PUT /status {depositId, status} (PUT được retry)', async () => {
    const { http, listing } = setup();
    await listing.changeStatus('L1', 'D1', 'AVAILABLE');
    expect(http.put).toHaveBeenCalledWith(
      'http://listing:3002/internal/listings/L1/status',
      { depositId: 'D1', status: 'AVAILABLE' },
      { timeoutMs: 2000 },
    );
  });
});

describe('PaymentClient', () => {
  it('createOrder: POST /internal/payment-orders, idempotent: true (khóa depositId), timeout PAYMENT_CALL_TIMEOUT_MS', async () => {
    const { http, payment } = setup();
    const body = {
      depositId: 'D1',
      tenantId: 'T1',
      ownerId: 'O1',
      listingTitle: 'Phòng',
      amountVnd: 3_000_000,
      expiresAt: new Date('2026-11-20T08:10:00.000Z'),
    };
    await payment.createOrder(body);
    expect(http.post).toHaveBeenCalledWith(
      'http://payment:3004/internal/payment-orders',
      { ...body, expiresAt: '2026-11-20T08:10:00.000Z' },
      { timeoutMs: 3000, idempotent: true },
    );
  });

  it('cancelOrder idempotent; getOrder GET', async () => {
    const { http, payment } = setup();
    await payment.cancelOrder('D1');
    expect(http.post).toHaveBeenCalledWith(
      'http://payment:3004/internal/payment-orders/D1/cancel',
      undefined,
      { timeoutMs: 3000, idempotent: true },
    );
    await payment.getOrder('D1');
    expect(http.get).toHaveBeenCalledWith('http://payment:3004/internal/payment-orders/D1', {
      timeoutMs: 3000,
    });
  });
  it('createRefund: POST /internal/refund-requests {depositId}, idempotent: true (payment trả lại yêu cầu đã có, T3.5)', async () => {
    const { http, payment } = setup();
    await payment.createRefund({ depositId: 'D1' });
    expect(http.post).toHaveBeenCalledWith(
      'http://payment:3004/internal/refund-requests',
      { depositId: 'D1' },
      { timeoutMs: 3000, idempotent: true },
    );
  });
});

describe('classifyCall (Component_Class_Design §3, C14)', () => {
  it.each([
    ['4xx của upstream', new AppException('LISTING_NOT_AVAILABLE', 'x', 409), 'BUSINESS_ERROR'],
    [
      '503 chưa gửi được',
      new AppException('UPSTREAM_UNAVAILABLE', 'x', 503, { outcome: 'NOT_EXECUTED' }),
      'NOT_EXECUTED',
    ],
    [
      '503 có thể đã chạy',
      new AppException('UPSTREAM_UNAVAILABLE', 'x', 503, { outcome: 'UNKNOWN' }),
      'UNKNOWN',
    ],
    [
      '504 timeout',
      new AppException('UPSTREAM_TIMEOUT', 'x', 504, { outcome: 'UNKNOWN' }),
      'UNKNOWN',
    ],
    ['503 không có outcome', new AppException('PAYMENT_PROVIDER_UNAVAILABLE', 'x', 503), 'UNKNOWN'],
    ['lỗi lạ', new Error('boom'), 'UNKNOWN'],
  ])('%s -> %s', (_, err, outcome) => {
    expect(classifyCall(err)).toBe(outcome);
  });
});
