import {
  hitsOf,
  resetUpstream,
  startUpstream,
  stopUpstream,
  TestHttpController,
} from './helpers/http-upstream';
import type { TestApp } from './helpers/create-test-app';

/**
 * ConfigModule chốt giá trị đã validate (kể cả mặc định) ngay lúc AppModule được import,
 * nên test đổi env phải đặt env TRƯỚC khi import createTestApp (import động bên dưới).
 */
describe('InternalHttpService: timeout mặc định lấy từ env HTTP_TIMEOUT_MS', () => {
  let t: TestApp;

  beforeAll(async () => {
    await startUpstream();
    process.env.HTTP_TIMEOUT_MS = '200';
    process.env.HTTP_MAX_RETRIES = '0';
    const { createTestApp } = await import('./helpers/create-test-app');
    t = await createTestApp([TestHttpController]);
  });
  afterAll(async () => {
    await t.app.close();
    await stopUpstream();
    delete process.env.HTTP_TIMEOUT_MS;
    delete process.env.HTTP_MAX_RETRIES;
  });
  beforeEach(resetUpstream);

  it('đích chậm 600ms -> 504 UPSTREAM_TIMEOUT sau 200ms và chỉ gọi 1 lần (không retry)', async () => {
    const started = Date.now();
    const res = await t.http().get('/api/v1/test-http/default-timeout');
    expect(res.status).toBe(504);
    expect(res.body.error.code).toBe('UPSTREAM_TIMEOUT');
    expect(hitsOf('/slow')).toBe(1);
    expect(Date.now() - started).toBeLessThan(550);
  });
});
