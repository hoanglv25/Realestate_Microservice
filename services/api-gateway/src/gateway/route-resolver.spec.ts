import { ConfigService } from '@nestjs/config';
import { AppException } from '../common/errors/app.exception';
import { EnvVars } from '../config/env.validation';
import { Access, ServiceName } from './routes';
import { RouteResolver } from './route-resolver';

const URLS = {
  INTERNAL_IDENTITY_URL: 'http://identity.test:3001',
  INTERNAL_LISTING_URL: 'http://listing.test:3002',
  INTERNAL_RENTAL_URL: 'http://rental.test:3003',
  INTERNAL_PAYMENT_URL: 'http://payment.test:3004',
  INTERNAL_NOTIFICATION_URL: 'http://notification.test:3005',
} as const;

const TARGETS: Record<ServiceName, string> = {
  identity: URLS.INTERNAL_IDENTITY_URL,
  listing: URLS.INTERNAL_LISTING_URL,
  rental: URLS.INTERNAL_RENTAL_URL,
  payment: URLS.INTERNAL_PAYMENT_URL,
  notification: URLS.INTERNAL_NOTIFICATION_URL,
};

const config = {
  getOrThrow: (key: keyof typeof URLS) => URLS[key],
} as unknown as ConfigService<EnvVars, true>;

const resolver = new RouteResolver(config);

function notFound(method: string, path: string): AppException {
  try {
    resolver.resolve(method, path);
  } catch (e) {
    return e as AppException;
  }
  throw new Error(`${method} ${path} phải không khớp route nào`);
}

describe('RouteResolver — mọi route công khai trong API_Spec của các service', () => {
  // [method, đường dẫn mẫu, service, mức] đối chiếu RE.GATEWAY/API_Spec.md §3 và API_Spec.md từng chức năng
  const cases: Array<[string, string, ServiceName, Access]> = [
    // identity
    ['POST', '/api/v1/auth/register', 'identity', 'public'],
    ['POST', '/api/v1/auth/verify-otp', 'identity', 'public'],
    ['POST', '/api/v1/auth/resend-otp', 'identity', 'public'],
    ['POST', '/api/v1/auth/login', 'identity', 'public'],
    ['POST', '/api/v1/auth/google', 'identity', 'public'],
    ['POST', '/api/v1/auth/refresh', 'identity', 'public'],
    ['POST', '/api/v1/auth/logout', 'identity', 'public'],
    ['POST', '/api/v1/auth/forgot-password', 'identity', 'public'],
    ['POST', '/api/v1/auth/reset-password', 'identity', 'public'],
    ['GET', '/api/v1/auth/me', 'identity', 'user'],
    ['PATCH', '/api/v1/users/me', 'identity', 'user'],
    ['PUT', '/api/v1/users/me/bank-account', 'identity', 'user'],
    ['GET', '/api/v1/users/me/bank-account', 'identity', 'user'],
    ['GET', '/api/v1/admin/users', 'identity', 'admin'],
    ['PATCH', '/api/v1/admin/users/u-1/role', 'identity', 'admin'],
    ['POST', '/api/v1/admin/users/u-1/lock', 'identity', 'admin'],
    ['POST', '/api/v1/admin/users/u-1/unlock', 'identity', 'admin'],
    // listing
    ['GET', '/api/v1/listings', 'listing', 'public'],
    ['GET', '/api/v1/listings/l-1', 'listing', 'public'],
    ['GET', '/api/v1/listings/mine', 'listing', 'landlord'],
    ['POST', '/api/v1/listings', 'listing', 'landlord'],
    ['PATCH', '/api/v1/listings/l-1', 'listing', 'landlord'],
    ['DELETE', '/api/v1/listings/l-1', 'listing', 'landlord'],
    ['POST', '/api/v1/listings/l-1/hide', 'listing', 'landlord'],
    ['POST', '/api/v1/listings/l-1/unhide', 'listing', 'landlord'],
    ['POST', '/api/v1/listings/l-1/images/upload-url', 'listing', 'landlord'],
    ['POST', '/api/v1/listings/l-1/images', 'listing', 'landlord'],
    ['POST', '/api/v1/admin/listings/l-1/approve', 'listing', 'admin'],
    ['POST', '/api/v1/admin/listings/l-1/reject', 'listing', 'admin'],
    // listing — danh mục địa giới (dòng 6a, v1.4, RE.LOCATION)
    ['GET', '/api/v1/cities', 'listing', 'public'],
    ['GET', '/api/v1/districts', 'listing', 'public'],
    // rental
    ['POST', '/api/v1/viewings', 'rental', 'user'],
    ['GET', '/api/v1/viewings/mine', 'rental', 'user'],
    ['POST', '/api/v1/viewings/v-1/respond', 'rental', 'user'],
    ['POST', '/api/v1/viewings/v-1/cancel', 'rental', 'user'],
    ['POST', '/api/v1/viewings/v-1/confirm-viewed', 'rental', 'user'],
    ['POST', '/api/v1/deposits', 'rental', 'user'],
    ['GET', '/api/v1/deposits/mine', 'rental', 'user'],
    ['GET', '/api/v1/deposits/d-1', 'rental', 'user'],
    ['POST', '/api/v1/deposits/d-1/acknowledge', 'rental', 'user'],
    ['POST', '/api/v1/deposits/d-1/confirm-move-in', 'rental', 'user'],
    ['POST', '/api/v1/deposits/d-1/refund-request', 'rental', 'user'],
    ['GET', '/api/v1/admin/deposits', 'rental', 'admin'],
    ['POST', '/api/v1/admin/deposits/d-1/hand-over', 'rental', 'admin'],
    // payment
    ['POST', '/api/v1/payments/payos/webhook', 'payment', 'payos'],
    ['GET', '/api/v1/payments/transactions/mine', 'payment', 'user'],
    ['POST', '/api/v1/withdrawals', 'payment', 'landlord'],
    ['GET', '/api/v1/withdrawals/mine', 'payment', 'landlord'],
    ['POST', '/api/v1/admin/withdrawals/w-1/complete', 'payment', 'admin'],
    ['POST', '/api/v1/admin/withdrawals/w-1/fail', 'payment', 'admin'],
    ['POST', '/api/v1/admin/refund-requests/r-1/complete', 'payment', 'admin'],
    ['POST', '/api/v1/admin/refund-requests/r-1/fail', 'payment', 'admin'],
    ['POST', '/api/v1/admin/refund-requests/r-1/reject', 'payment', 'admin'],
    ['GET', '/api/v1/admin/wallet', 'payment', 'admin'],
    ['GET', '/api/v1/admin/audit-logs', 'payment', 'admin'],
    // notification
    ['GET', '/api/v1/notifications', 'notification', 'user'],
    ['PATCH', '/api/v1/notifications/n-1/read', 'notification', 'user'],
    ['GET', '/api/v1/conversations', 'notification', 'user'],
    ['POST', '/api/v1/conversations', 'notification', 'user'],
    ['GET', '/api/v1/conversations/c-1/messages', 'notification', 'user'],
    ['POST', '/api/v1/conversations/c-1/messages', 'notification', 'user'],
    ['GET', '/ws', 'notification', 'user'],
  ];

  it.each(cases)('%s %s -> %s (%s)', (method, path, service, access) => {
    expect(resolver.resolve(method, path)).toEqual({
      service,
      target: TARGETS[service],
      access,
    });
  });
});

describe('RouteResolver — quy tắc khớp (RE.GATEWAY/API_Spec.md §3, v1.3)', () => {
  it('dòng cụ thể thắng dòng chung: webhook payOS mức payos, route payments còn lại mức user', () => {
    expect(resolver.resolve('POST', '/api/v1/payments/payos/webhook').access).toBe('payos');
    expect(resolver.resolve('GET', '/api/v1/payments/payos/webhook').access).toBe('user');
    expect(resolver.resolve('POST', '/api/v1/payments/anything').access).toBe('user');
  });

  it('chỉ GET /listings và GET /listings/:id là public; ghi/sửa/xóa là landlord', () => {
    expect(resolver.resolve('GET', '/api/v1/listings').access).toBe('public');
    expect(resolver.resolve('POST', '/api/v1/listings').access).toBe('landlord');
    expect(resolver.resolve('PUT', '/api/v1/listings/l-1').access).toBe('landlord');
    // :id chỉ một đoạn: đường dẫn sâu hơn không thừa hưởng public
    expect(resolver.resolve('GET', '/api/v1/listings/l-1/images').access).toBe('landlord');
  });

  it('`/*` khớp chính tiền tố và mọi đường dẫn dưới nó, theo ranh giới đoạn', () => {
    expect(resolver.resolve('POST', '/api/v1/auth').service).toBe('identity');
    expect(resolver.resolve('POST', '/api/v1/auth/a/b/c').service).toBe('identity');
    expect(notFound('POST', '/api/v1/authx/login').code).toBe('GATEWAY_ROUTE_NOT_FOUND');
    expect(notFound('GET', '/api/v1/users/meh').code).toBe('GATEWAY_ROUTE_NOT_FOUND');
  });

  it('`/api/v1/admin/wallet` và `/audit-logs` khớp chính xác, không khớp đường dẫn con khác', () => {
    expect(resolver.resolve('GET', '/api/v1/admin/wallet').access).toBe('admin');
    expect(notFound('GET', '/api/v1/admin/wallets').code).toBe('GATEWAY_ROUTE_NOT_FOUND');
    expect(notFound('GET', '/api/v1/admin/secret').code).toBe('GATEWAY_ROUTE_NOT_FOUND');
  });

  it('HEAD khớp như GET', () => {
    expect(resolver.resolve('HEAD', '/api/v1/listings')).toMatchObject({ access: 'public' });
    expect(resolver.resolve('head', '/api/v1/listings/mine')).toMatchObject({ access: 'landlord' });
  });

  it('bỏ query string và dấu / cuối khi khớp; method không phân biệt hoa thường', () => {
    expect(resolver.resolve('get', '/api/v1/listings?city=hanoi&page=2').access).toBe('public');
    expect(resolver.resolve('GET', '/api/v1/listings/').access).toBe('public');
    expect(resolver.resolve('GET', '/api/v1/listings/mine?x=1').access).toBe('landlord');
  });

  it('không khớp dòng nào -> 404 GATEWAY_ROUTE_NOT_FOUND, không lộ địa chỉ nội bộ', () => {
    const e = notFound('GET', '/api/v1/khong-co');
    expect(e.getStatus()).toBe(404);
    expect(e.code).toBe('GATEWAY_ROUTE_NOT_FOUND');
    expect(JSON.stringify(e.getResponse())).not.toContain('.test');
  });

  it('v1.4: danh mục địa giới chỉ GET, có query; method khác và đường dẫn con không khớp', () => {
    expect(resolver.resolve('GET', '/api/v1/districts?cityId=c-1&pageSize=50')).toMatchObject({
      service: 'listing',
      access: 'public',
    });
    for (const [method, path] of [
      ['POST', '/api/v1/cities'],
      ['DELETE', '/api/v1/districts'],
      ['GET', '/api/v1/cities/c-1'],
      ['GET', '/api/v1/cities/c-1/districts'],
    ]) {
      expect(notFound(method, path).code).toBe('GATEWAY_ROUTE_NOT_FOUND');
    }
  });

  it('/internal/*, /health và đường dẫn không có tiền tố /api/v1 không nằm trong bảng', () => {
    for (const path of ['/internal/listings/x', '/health', '/api/v1/health', '/', '/listings']) {
      expect(notFound('GET', path).code).toBe('GATEWAY_ROUTE_NOT_FOUND');
    }
  });

  // Express (và service đích) định tuyến KHÔNG phân biệt hoa thường: `/listings/MINE` vẫn tới handler `mine`.
  // Nếu gateway phân biệt, `MINE` khớp `:id` (public) và né kiểm token, như lỗi `mine` của v1.3.
  it.each(['MINE', 'Mine', 'mInE'])(
    'GET /api/v1/listings/%s là landlord, không phải public',
    (seg) => {
      expect(resolver.resolve('GET', `/api/v1/listings/${seg}`)).toMatchObject({
        service: 'listing',
        access: 'landlord',
      });
      expect(resolver.resolve('GET', `/api/v1/listings/${seg}?x=1`).access).toBe('landlord');
    },
  );

  it.each([
    ['POST', '/API/V1/ADMIN/users/u-1/lock', 'identity', 'admin'],
    ['GET', '/Api/V1/Admin/Wallet', 'payment', 'admin'],
    ['GET', '/API/V1/AUTH/ME', 'identity', 'user'],
    ['POST', '/api/v1/Payments/PayOS/Webhook', 'payment', 'payos'],
    ['GET', '/API/V1/LISTINGS', 'listing', 'public'],
    ['GET', '/api/v1/Listings/l-1', 'listing', 'public'],
    ['GET', '/WS/', 'notification', 'user'],
  ] as Array<[string, string, ServiceName, Access]>)(
    'khớp không phân biệt hoa thường: %s %s -> %s (%s)',
    (method, path, service, access) => {
      expect(resolver.resolve(method, path)).toMatchObject({ service, access });
    },
  );

  it('so không phân biệt hoa thường nhưng đoạn `:id` giữ nguyên, và không khớp thêm đường dẫn khác', () => {
    expect(resolver.resolve('GET', '/api/v1/listings/ABC-123').access).toBe('public');
    expect(notFound('GET', '/API/V1/AUTHX/login').code).toBe('GATEWAY_ROUTE_NOT_FOUND');
    expect(notFound('GET', '/api/v1/ADMIN/WALLETS').code).toBe('GATEWAY_ROUTE_NOT_FOUND');
    // Mã hóa phần trăm vẫn không bao giờ khớp (không giải mã để tìm kiếm khớp)
    expect(notFound('GET', '/api/v1/listings/%4dINE/x/%2E%2E').code).toBe(
      'GATEWAY_ROUTE_NOT_FOUND',
    );
  });

  it('fail-closed với đường dẫn lạ: `..`, `.`, đoạn rỗng, %2e %2f %5c không bao giờ khớp', () => {
    const bad = [
      '/api/v1/listings/../admin/listings/l-1/approve',
      '/api/v1/listings/./mine',
      '/api/v1//listings',
      '/api/v1/listings//l-1',
      '/api/v1/listings/%2e%2e/admin/users',
      '/api/v1/listings/%2E%2E/x',
      '/api/v1/listings/a%2fb',
      '/api/v1/listings/a%5cb',
    ];
    for (const path of bad) {
      expect([path, notFound('GET', path).code]).toEqual([path, 'GATEWAY_ROUTE_NOT_FOUND']);
    }
  });

  it('target lấy từ INTERNAL_<SERVICE>_URL, đọc lúc resolve', () => {
    expect(resolver.resolve('GET', '/api/v1/notifications').target).toBe(
      'http://notification.test:3005',
    );
  });
});
