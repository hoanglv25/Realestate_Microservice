import { ROUTES, SERVICE_ENV_URL } from './routes';

describe('ROUTES — bảng định tuyến (dữ liệu)', () => {
  it('mỗi dòng có đường dẫn bắt đầu bằng /, không có / cuối (trừ /*), không có đoạn rỗng', () => {
    for (const r of ROUTES) {
      expect(r.pattern).toMatch(/^\/[^/]/);
      expect(r.pattern).not.toMatch(/\/\/|\/$/);
      expect(r.pattern.slice(0, -2)).not.toContain('*'); // `*` chỉ đứng ở cuối dưới dạng `/*`
    }
  });

  it('method (nếu có) viết hoa và hợp lệ', () => {
    for (const r of ROUTES) {
      for (const m of r.methods ?? [])
        expect(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']).toContain(m);
    }
  });

  it('không có hai dòng trùng (method, đường dẫn): dòng sau sẽ không bao giờ được dùng', () => {
    const keys = ROUTES.map((r) => `${(r.methods ?? ['*']).join(',')} ${r.pattern}`);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('mỗi service đích có biến INTERNAL_<SERVICE>_URL', () => {
    for (const r of ROUTES) expect(SERVICE_ENV_URL[r.service]).toMatch(/^INTERNAL_[A-Z]+_URL$/);
  });

  it('webhook payOS là dòng duy nhất mức payos và chỉ nhận POST', () => {
    const payos = ROUTES.filter((r) => r.access === 'payos');
    expect(payos).toEqual([
      {
        methods: ['POST'],
        pattern: '/api/v1/payments/payos/webhook',
        service: 'payment',
        access: 'payos',
      },
    ]);
  });

  it('chỉ GET /listings, GET /listings/:id, GET /cities, GET /districts (và auth, webhook) là không cần token', () => {
    const open = ROUTES.filter((r) => r.access === 'public' || r.access === 'payos').map(
      (r) => `${(r.methods ?? ['*']).join(',')} ${r.pattern}`,
    );
    expect(open.sort()).toEqual(
      [
        '* /api/v1/auth/*',
        'GET /api/v1/cities', // v1.4, RE.LOCATION
        'GET /api/v1/districts', // v1.4, RE.LOCATION
        'GET /api/v1/listings',
        'GET /api/v1/listings/:id',
        'POST /api/v1/payments/payos/webhook',
      ].sort(),
    );
  });
});
