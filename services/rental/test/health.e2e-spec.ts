import { HealthRegistry } from '../src/health/health.registry';
import { createTestApp, TestApp } from './helpers/create-test-app';

describe('GET /health (không bật DB/Redis)', () => {
  let t: TestApp;

  beforeAll(async () => {
    t = await createTestApp();
  });
  afterAll(async () => {
    await t.app.close();
  });

  it.each(['/health', '/api/v1/health'])('%s trả 200 đúng format', async (path) => {
    const res = await t.http().get(path);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      status: 'ok',
      service: 'template-nest-test',
      version: expect.stringMatching(/^\d+\.\d+\.\d+/),
      uptime: expect.any(Number),
      checks: {}, // chưa bật phụ thuộc nào nên không có db/redis
    });
    expect(res.headers['x-request-id']).toBeDefined();
  });

  it('không công bố framework qua header X-Powered-By', async () => {
    const res = await t.http().get('/health');
    expect(res.headers['x-powered-by']).toBeUndefined();
  });

  it('/health (Docker) không bị log, /api/v1/health thì có', async () => {
    await t.http().get('/health').set('X-Request-ID', 'hc-docker');
    await t.http().get('/api/v1/health').set('X-Request-ID', 'hc-api');
    const ids = t.logRecords().map((r) => r.correlationId);
    expect(ids).not.toContain('hc-docker');
    expect(ids).toContain('hc-api');
  });
});

describe('GET /health khi có phụ thuộc chết', () => {
  let t: TestApp;

  beforeAll(async () => {
    t = await createTestApp();
  });
  afterAll(async () => {
    await t.app.close();
  });

  it('db chết -> 503, status "error", checks.db = "down", checks.redis = "up"', async () => {
    const registry = t.app.get(HealthRegistry);
    registry.register('db', async () => false);
    registry.register('redis', async () => true);

    const res = await t.http().get('/health');
    expect(res.status).toBe(503);
    expect(res.body.status).toBe('error');
    expect(res.body.checks).toEqual({ db: 'down', redis: 'up' });
    expect(res.body.service).toBe('template-nest-test');
  });

  it('probe ném lỗi -> down; probe treo quá 2 giây -> down (không treo /health)', async () => {
    const registry = t.app.get(HealthRegistry);
    registry.register('db', async () => {
      throw new Error('connection refused');
    });
    registry.register('redis', () => new Promise<boolean>(() => undefined)); // không bao giờ xong

    const started = Date.now();
    const res = await t.http().get('/api/v1/health');
    expect(res.status).toBe(503);
    expect(res.body.checks).toEqual({ db: 'down', redis: 'down' });
    expect(Date.now() - started).toBeLessThan(4000);
  }, 10000);

  it('probe sống lại -> trở về 200', async () => {
    const registry = t.app.get(HealthRegistry);
    registry.register('db', async () => true);
    registry.register('redis', async () => true);
    const res = await t.http().get('/health');
    expect(res.status).toBe(200);
    expect(res.body.checks).toEqual({ db: 'up', redis: 'up' });
  });
});
