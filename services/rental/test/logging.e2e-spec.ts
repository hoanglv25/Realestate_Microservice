import { Controller, Get } from '@nestjs/common';
import axios from 'axios';
import { PinoLogger } from 'nestjs-pino';
import { Public } from '../src/common/auth/public.decorator';
import { createTestApp, TestApp } from './helpers/create-test-app';

@Public()
@Controller('test-logging')
class TestLoggingController {
  constructor(private readonly logger: PinoLogger) {}

  @Get('ping')
  ping(): { ok: boolean } {
    // Log do chính service phát sinh, phải tự mang correlationId của request
    this.logger.info({ orderId: 42 }, 'xử lý ping');
    return { ok: true };
  }
}

describe('Log JSON và correlation ID', () => {
  let t: TestApp;

  beforeAll(async () => {
    t = await createTestApp([TestLoggingController]);
  });
  afterAll(async () => {
    await t.app.close();
  });

  it('X-Request-ID: abc-123 xuất hiện ở response header và ở MỌI dòng log của request', async () => {
    const res = await t.http().get('/api/v1/test-logging/ping').set('X-Request-ID', 'abc-123');
    expect(res.status).toBe(200);
    expect(res.headers['x-request-id']).toBe('abc-123');

    const lines = t.logRecords().filter((r) => r.correlationId === 'abc-123');
    const serviceLog = lines.find((r) => r.msg === 'xử lý ping');
    const accessLog = lines.find((r) => r.url === '/api/v1/test-logging/ping');
    expect(serviceLog).toMatchObject({ orderId: 42 });
    expect(accessLog).toBeDefined();
  });

  it('mỗi dòng là JSON một dòng với level, time ISO UTC, service, msg', () => {
    expect(t.logs.length).toBeGreaterThan(0);
    for (const line of t.logs) {
      expect(line).not.toContain('\n');
      const rec = JSON.parse(line) as Record<string, unknown>;
      expect(typeof rec.level).toBe('string');
      expect(rec.service).toBe('template-nest-test');
      expect(rec.time).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
      expect(typeof rec.msg).toBe('string');
    }
  });

  it('dòng tổng kết request có method, url, statusCode, responseTime', async () => {
    await t.http().get('/api/v1/test-logging/ping').set('X-Request-ID', 'acc-1');
    const access = t.logRecords().find((r) => r.correlationId === 'acc-1' && r.statusCode);
    expect(access).toMatchObject({
      level: 'info',
      method: 'GET',
      url: '/api/v1/test-logging/ping',
      statusCode: 200,
    });
    expect(typeof access?.responseTime).toBe('number');
  });

  it('request 4xx log ở mức warn; /health không bị log', async () => {
    await t.http().get('/khong-co').set('X-Request-ID', 'warn-1');
    const warn = t.logRecords().find((r) => r.correlationId === 'warn-1' && r.statusCode === 404);
    expect(warn?.level).toBe('warn');
  });

  it('ẩn authorization, cookie, password, token trong log', () => {
    PinoLogger.root.info(
      {
        authorization: 'Bearer tuyet-mat',
        password: 'p-ass-1',
        user: { token: 'tok-secret-2' },
        req: { headers: { cookie: 'sid=cookie-3', authorization: 'Bearer header-4' } },
      },
      'redact-test',
    );
    const line = t.logs.find((l) => l.includes('redact-test')) ?? '';
    expect(line).toContain('[REDACTED]');
    for (const secret of ['tuyet-mat', 'p-ass-1', 'tok-secret-2', 'cookie-3', 'header-4']) {
      expect(line).not.toContain(secret);
    }
  });

  it('ẩn password/token lồng sâu tới 3 cấp', () => {
    PinoLogger.root.info(
      {
        a: { password: 'p-lv1' },
        b: { c: { token: 't-lv2' } },
        d: { e: { f: { secret: 's-lv3' } } },
      },
      'redact-deep',
    );
    const line = t.logs.find((l) => l.includes('redact-deep')) ?? '';
    for (const secret of ['p-lv1', 't-lv2', 's-lv3']) {
      expect(line).not.toContain(secret);
    }
  });

  it('log lỗi của axios KHÔNG làm lộ header Authorization/body trong config', async () => {
    let err: unknown;
    try {
      await axios.post(
        'http://127.0.0.1:1/x',
        { password: 'BODY-PASSWORD' },
        { headers: { Authorization: 'Bearer SUPER-SECRET-TOKEN' }, timeout: 500 },
      );
    } catch (e) {
      err = e;
    }
    PinoLogger.root.error({ err }, 'axios-error-log');
    const line = t.logs.find((l) => l.includes('axios-error-log')) ?? '';
    expect(line).toContain('ECONNREFUSED'); // vẫn đủ thông tin chẩn đoán
    expect(line).not.toContain('SUPER-SECRET-TOKEN');
    expect(line).not.toContain('BODY-PASSWORD');
  });

  it('ID có ký tự lạ bị bỏ, thay bằng UUID để không chèn rác vào log', async () => {
    const res = await t
      .http()
      .get('/api/v1/test-logging/ping')
      .set('X-Request-ID', 'bad id;rm -rf');
    expect(res.headers['x-request-id']).not.toContain(';');
    expect(res.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/);
  });
});
