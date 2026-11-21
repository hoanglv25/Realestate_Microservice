import { createTestApp, TestApp, UUID_V4 } from './helpers/create-test-app';
import {
  hitsOf,
  resetUpstream,
  seen,
  startUpstream,
  stopUpstream,
  TestHttpController,
} from './helpers/http-upstream';

beforeAll(startUpstream);
afterAll(stopUpstream);
beforeEach(resetUpstream);
describe('InternalHttpService (HTTP client gọi service khác)', () => {
  let t: TestApp;

  beforeAll(async () => {
    t = await createTestApp([TestHttpController]);
  });
  afterAll(async () => {
    await t.app.close();
  });

  describe('correlation ID', () => {
    it('X-Request-ID: abc-123 đi xuyên sang service đích', async () => {
      const res = await t
        .http()
        .get('/api/v1/test-http/get?path=/ok')
        .set('X-Request-ID', 'abc-123');
      expect(res.status).toBe(200);
      expect(res.body.data.requestId).toBe('abc-123');
      expect(seen[0].headers['x-request-id']).toBe('abc-123');
      expect(res.headers['x-request-id']).toBe('abc-123');
    });

    it('không có X-Request-ID: ID tự sinh được truyền sang đích và trùng với response', async () => {
      const res = await t.http().get('/api/v1/test-http/get?path=/ok');
      expect(res.headers['x-request-id']).toMatch(UUID_V4);
      expect(seen[0].headers['x-request-id']).toBe(res.headers['x-request-id']);
    });
  });

  describe('retry', () => {
    it('GET gặp 503 hai lần rồi thành công: tự thử lại, tổng 3 lần gọi', async () => {
      const res = await t.http().get('/api/v1/test-http/get?path=/flaky%3Ffail%3D2%26id%3Da');
      expect(res.status).toBe(200);
      expect(res.body.data).toEqual({ ok: true, attempts: 3 });
      expect(hitsOf('/flaky')).toBe(3);
    });

    it('GET 503 liên tục: thử tối đa 2 lần lại (3 lần gọi) rồi 503 UPSTREAM_UNAVAILABLE', async () => {
      const res = await t.http().get('/api/v1/test-http/get?path=/always503');
      expect(res.status).toBe(503);
      expect(res.body.error.code).toBe('UPSTREAM_UNAVAILABLE');
      expect(hitsOf('/always503')).toBe(3);
    });

    it('POST thường KHÔNG được thử lại (có thể gây trùng lặp)', async () => {
      const res = await t.http().post('/api/v1/test-http/post?path=/always503').send({ a: 1 });
      expect(res.status).toBe(503);
      expect(hitsOf('/always503')).toBe(1);
    });

    it('POST khai báo idempotent:true thì được thử lại', async () => {
      const res = await t
        .http()
        .post('/api/v1/test-http/post?path=/always503&idem=1')
        .send({ a: 1 });
      expect(res.status).toBe(503);
      expect(hitsOf('/always503')).toBe(3);
    });

    it('PUT và DELETE (idempotent theo HTTP) được thử lại', async () => {
      await t.http().put('/api/v1/test-http/put?path=/always503').send({});
      expect(hitsOf('/always503')).toBe(3);
      seen.length = 0;
      await t.http().delete('/api/v1/test-http/delete?path=/always503');
      expect(hitsOf('/always503')).toBe(3);
    });

    it('500 từ upstream không thử lại (không chắc là lỗi tạm thời)', async () => {
      const res = await t.http().get('/api/v1/test-http/get?path=/always500');
      expect(res.status).toBe(503);
      expect(hitsOf('/always500')).toBe(1);
      expect(JSON.stringify(res.body)).not.toContain('upstream.ts'); // không lộ nội dung lỗi của đích
    });
  });

  describe('chuyển đổi lỗi', () => {
    it('4xx của service đích được GIỮ NGUYÊN mã, code, message, details và không thử lại', async () => {
      const res = await t
        .http()
        .get('/api/v1/test-http/get?path=/conflict')
        .set('X-Request-ID', 'c-1');
      expect(res.status).toBe(409);
      expect(res.body).toEqual({
        error: {
          code: 'DEPOSIT_ALREADY_PAID',
          message: 'Đơn đặt cọc đã được thanh toán',
          details: { depositId: 'd-1' },
        },
        // correlationId của service này, không phải của đích
        meta: { correlationId: 'c-1', timestamp: expect.any(String) },
      });
      expect(hitsOf('/conflict')).toBe(1);
    });

    it('4xx không đúng format dự án -> giữ mã, code suy từ status', async () => {
      const res = await t.http().get('/api/v1/test-http/get?path=/plain404');
      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe('NOT_FOUND');
    });

    it('timeout -> 504 UPSTREAM_TIMEOUT (GET được thử lại)', async () => {
      const res = await t.http().get('/api/v1/test-http/timeout');
      expect(res.status).toBe(504);
      expect(res.body.error.code).toBe('UPSTREAM_TIMEOUT');
      expect(hitsOf('/slow')).toBe(3);
    });

    it('đích trả 504 -> 504 UPSTREAM_TIMEOUT', async () => {
      const res = await t.http().get('/api/v1/test-http/get?path=/always504');
      expect(res.status).toBe(504);
      expect(res.body.error.code).toBe('UPSTREAM_TIMEOUT');
    });

    it('không kết nối được -> 503 UPSTREAM_UNAVAILABLE, không lộ địa chỉ nội bộ', async () => {
      const res = await t.http().get('/api/v1/test-http/refused');
      expect(res.status).toBe(503);
      expect(res.body.error.code).toBe('UPSTREAM_UNAVAILABLE');
      expect(JSON.stringify(res.body)).not.toContain('127.0.0.1');
    });
  });

  // C14 (RE.SERVICE_TEMPLATE/API_Spec.md §3): người gọi (saga) cần biết lệnh đã gửi tới đích hay chưa
  describe('details.outcome (C14)', () => {
    it('ECONNREFUSED: chưa gửi được request -> NOT_EXECUTED', async () => {
      const res = await t.http().post('/api/v1/test-http/refused-post').send({ a: 1 });
      expect(res.status).toBe(503);
      expect(res.body.error.code).toBe('UPSTREAM_UNAVAILABLE');
      expect(res.body.error.details).toEqual({ outcome: 'NOT_EXECUTED' });
    });

    it('timeout: request có thể đã tới đích -> 504 UNKNOWN', async () => {
      const res = await t.http().get('/api/v1/test-http/timeout');
      expect(res.status).toBe(504);
      expect(res.body.error.details).toEqual({ outcome: 'UNKNOWN' });
    });

    it('đích trả 503 -> UNKNOWN (đích đã nhận request)', async () => {
      const res = await t.http().get('/api/v1/test-http/get?path=/always503');
      expect(res.status).toBe(503);
      expect(res.body.error.details).toEqual({ outcome: 'UNKNOWN' });
    });

    it('đích trả 504 -> 504 UNKNOWN', async () => {
      const res = await t.http().get('/api/v1/test-http/get?path=/always504');
      expect(res.status).toBe(504);
      expect(res.body.error.details).toEqual({ outcome: 'UNKNOWN' });
    });

    it('đích trả 500 -> 503 UNKNOWN', async () => {
      const res = await t.http().get('/api/v1/test-http/get?path=/always500');
      expect(res.status).toBe(503);
      expect(res.body.error.details).toEqual({ outcome: 'UNKNOWN' });
    });

    it('4xx của đích giữ nguyên details của đích, không chèn outcome', async () => {
      const conflict = await t.http().get('/api/v1/test-http/get?path=/conflict');
      expect(conflict.body.error.details).toEqual({ depositId: 'd-1' });
      const plain = await t.http().get('/api/v1/test-http/get?path=/plain404');
      expect(plain.body.error).not.toHaveProperty('details');
    });
  });
});
