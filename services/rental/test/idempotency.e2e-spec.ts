import { Body, Controller, Post } from '@nestjs/common';
import { IsInt, Min } from 'class-validator';
import { Public } from '../src/common/auth/public.decorator';
import { AppException } from '../src/common/errors/app.exception';
import { Idempotent } from '../src/common/idempotency/idempotent.decorator';
import { RedisService } from '../src/redis/redis.service';
import { createTestApp, TestApp } from './helpers/create-test-app';

/** Redis giả trong bộ nhớ: chỉ cài những lệnh interceptor dùng (SET [EX] [NX], GET, DEL). */
class FakeRedis {
  store = new Map<string, string>();
  setCalls: Array<{ key: string; args: Array<string | number> }> = [];
  failFinalSave = false;

  async set(key: string, value: string, ...args: Array<string | number>): Promise<'OK' | null> {
    this.setCalls.push({ key, args });
    const nx = args.includes('NX');
    if (!nx && this.failFinalSave) throw new Error('redis down khi lưu kết quả');
    if (nx && this.store.has(key)) return null;
    this.store.set(key, value);
    return 'OK';
  }
  async get(key: string): Promise<string | null> {
    return this.store.get(key) ?? null;
  }
  async del(key: string): Promise<number> {
    return this.store.delete(key) ? 1 : 0;
  }
}

class PayDto {
  @IsInt()
  @Min(1)
  amountVnd!: number;

  @IsInt()
  @Min(1)
  roomId!: number;
}

@Public()
@Controller('test-idem')
class TestIdemController {
  calls = 0;
  failNext = false;

  @Post('pay')
  @Idempotent()
  pay(@Body() dto: PayDto): { paymentId: string; amountVnd: number } {
    this.calls++;
    return { paymentId: `pay-${this.calls}`, amountVnd: dto.amountVnd };
  }

  @Post('flaky')
  @Idempotent()
  flaky(): { ok: boolean; n: number } {
    if (this.failNext) {
      this.failNext = false;
      throw new AppException('BIZ_FAILED', 'Nghiệp vụ lỗi', 409);
    }
    return { ok: true, n: ++this.calls };
  }

  @Post('slow')
  @Idempotent()
  async slow(): Promise<{ ok: boolean }> {
    await new Promise((resolve) => setTimeout(resolve, 300));
    return { ok: true };
  }
}

describe('@Idempotent() với Idempotency-Key', () => {
  let t: TestApp;
  let redis: FakeRedis;
  let ctrl: TestIdemController;

  beforeEach(async () => {
    redis = new FakeRedis();
    t = await createTestApp(
      [TestIdemController],
      [{ provide: RedisService, useValue: { client: redis } }],
    );
    ctrl = t.app.get(TestIdemController);
  });
  afterEach(async () => {
    await t.app.close();
  });

  const pay = (key: string | undefined, body: object = { amountVnd: 5000000, roomId: 7 }) => {
    const req = t.http().post('/api/v1/test-idem/pay');
    if (key) req.set('Idempotency-Key', key);
    return req.send(body);
  };

  it('thiếu header -> 400 IDEMPOTENCY_KEY_REQUIRED; key chứa ký tự lạ -> 400', async () => {
    const missing = await pay(undefined);
    expect(missing.status).toBe(400);
    expect(missing.body.error.code).toBe('IDEMPOTENCY_KEY_REQUIRED');

    const bad = await pay('key;co dau cach');
    expect(bad.status).toBe(400);
    expect(bad.body.error.code).toBe('BAD_REQUEST');
    expect(ctrl.calls).toBe(0);
  });

  it('cùng key + cùng body -> trả lại response cũ, handler chỉ chạy MỘT lần', async () => {
    const first = await pay('k-0001');
    expect(first.status).toBe(201);
    expect(first.body.data).toEqual({ paymentId: 'pay-1', amountVnd: 5000000 });
    expect(first.headers['idempotent-replayed']).toBeUndefined();

    const second = await pay('k-0001');
    expect(second.status).toBe(201);
    expect(second.body.data).toEqual({ paymentId: 'pay-1', amountVnd: 5000000 });
    expect(second.headers['idempotent-replayed']).toBe('true');
    expect(ctrl.calls).toBe(1);
  });

  it('thứ tự khóa trong body khác nhau nhưng nội dung giống -> vẫn là replay', async () => {
    await pay('k-0002', { amountVnd: 100, roomId: 1 });
    const again = await pay('k-0002', { roomId: 1, amountVnd: 100 });
    expect(again.headers['idempotent-replayed']).toBe('true');
    expect(ctrl.calls).toBe(1);
  });

  it('key khác -> thao tác mới', async () => {
    await pay('k-0003');
    const other = await pay('k-0004');
    expect(other.body.data.paymentId).toBe('pay-2');
    expect(ctrl.calls).toBe(2);
  });

  it('cùng key + body KHÁC -> 422 IDEMPOTENCY_KEY_REUSED, handler không chạy thêm', async () => {
    await pay('k-0005', { amountVnd: 100, roomId: 1 });
    const res = await pay('k-0005', { amountVnd: 999, roomId: 1 });
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('IDEMPOTENCY_KEY_REUSED');
    expect(res.body.meta.correlationId).toBeDefined();
    expect(ctrl.calls).toBe(1);
  });

  it('hai request ĐỒNG THỜI cùng key -> một chạy, một 409 IDEMPOTENCY_IN_PROGRESS; sau đó replay', async () => {
    const post = () =>
      t.http().post('/api/v1/test-idem/slow').set('Idempotency-Key', 'k-slow-1').send({});
    const [a, b] = await Promise.all([post(), post()]);
    expect([a.status, b.status].sort()).toEqual([201, 409]);
    const loser = a.status === 409 ? a : b;
    expect(loser.body.error.code).toBe('IDEMPOTENCY_IN_PROGRESS');

    const later = await post();
    expect(later.status).toBe(201);
    expect(later.headers['idempotent-replayed']).toBe('true');
  });

  it('handler lỗi thì KHÔNG lưu kết quả: thử lại cùng key sẽ chạy lại', async () => {
    ctrl.failNext = true;
    const post = () =>
      t.http().post('/api/v1/test-idem/flaky').set('Idempotency-Key', 'k-flaky').send({});
    const failed = await post();
    expect(failed.status).toBe(409);
    expect(failed.body.error.code).toBe('BIZ_FAILED');

    const retry = await post();
    expect(retry.status).toBe(201);
    expect(retry.body.data).toEqual({ ok: true, n: 1 });
  });

  it('cùng key ở route khác nhau không đụng nhau', async () => {
    await pay('k-shared');
    const flaky = await t
      .http()
      .post('/api/v1/test-idem/flaky')
      .set('Idempotency-Key', 'k-shared')
      .send({});
    expect(flaky.status).toBe(201);
    expect(flaky.headers['idempotent-replayed']).toBeUndefined();
  });

  it('lưu kết quả với TTL 24 giờ (86400 giây); khóa "đang xử lý" ngắn hơn', async () => {
    await pay('k-ttl');
    const [lock, done] = redis.setCalls;
    expect(lock.args).toEqual(['EX', 60, 'NX']);
    expect(done.args).toEqual(['EX', 86400]);
    expect([...redis.store.keys()][0]).toMatch(
      /^idem:template-nest-test:POST:\/api\/v1\/test-idem\/pay:anon:k-ttl$/,
    );
  });

  it('lưu kết quả thất bại -> vẫn trả thành công, khóa được xóa (không kẹt 409)', async () => {
    redis.failFinalSave = true;
    const first = await pay('k-fail-save');
    expect(first.status).toBe(201);
    expect(redis.store.size).toBe(0);
    redis.failFinalSave = false;
    const retry = await pay('k-fail-save');
    expect(retry.status).toBe(201);
    expect(ctrl.calls).toBe(2);
  });
});

describe('@Idempotent() khi chưa bật Redis', () => {
  it('trả 503 IDEMPOTENCY_UNAVAILABLE rõ ràng thay vì lỗi DI', async () => {
    const t = await createTestApp([TestIdemController]);
    try {
      const res = await t
        .http()
        .post('/api/v1/test-idem/pay')
        .set('Idempotency-Key', 'k-1')
        .send({ amountVnd: 1, roomId: 1 });
      expect(res.status).toBe(503);
      expect(res.body.error.code).toBe('IDEMPOTENCY_UNAVAILABLE');
    } finally {
      await t.app.close();
    }
  });
});
