import type { TestApp } from './helpers/create-test-app';

/**
 * Kiểm tra wiring khi BẬT module tùy chọn. Redis trỏ vào cổng không có ai lắng nghe nên không
 * cần Redis thật: chỉ cần app khởi động được (DI đủ) và /health báo redis = down (503).
 * (DatabaseModule cố ý không test ở đây vì TypeORM dừng app khi DB không kết nối được.)
 * AppModule đọc env lúc import nên phải import động SAU khi đặt biến môi trường.
 */
describe('Bật module Redis (REDIS_URL trỏ vào cổng chết)', () => {
  let t: TestApp;

  beforeAll(async () => {
    process.env.REDIS_URL = 'redis://127.0.0.1:1';
    const { createTestApp } = await import('./helpers/create-test-app');
    t = await createTestApp();
  });
  afterAll(async () => {
    await t.app.close();
    delete process.env.REDIS_URL;
  });

  it('app khởi động được và /health có checks.redis = "down" kèm HTTP 503', async () => {
    const res = await t.http().get('/health');
    expect(res.status).toBe(503);
    expect(res.body.status).toBe('error');
    expect(res.body.checks).toEqual({ redis: 'down' });
  });

  it('lỗi kết nối Redis được log cảnh báo kèm context RedisService', async () => {
    await t.http().get('/health');
    const warn = t.logRecords().find((r) => r.context === 'RedisService' && r.level === 'warn');
    expect(warn).toBeDefined();
  });
});
