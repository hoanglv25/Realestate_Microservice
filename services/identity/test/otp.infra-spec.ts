import { randomUUID } from 'node:crypto';
import { expectEventMatchesContract } from './helpers/contracts';
import { startIdentityInfra } from './helpers/identity-infra';
import type { IdentityInfra } from './helpers/identity-infra';
import { expectNoMail, otpOf, waitForMails } from './helpers/mail-capture';

/**
 * Đăng ký, xác minh email OTP, đăng nhập theo trạng thái: test 13–17 của `Component_Class_Design §5`,
 * với Postgres + Redis + RabbitMQ THẬT; email bắt bằng transport giả (`helpers/mail-capture.ts`, C27).
 * Email gửi KHÔNG chờ nên test hỏi lại vài lần.
 */
describe('Xác minh email OTP với hạ tầng thật', () => {
  let x: IdentityInfra;
  const PASSWORD = 'Mat-khau-du-dai-1';
  const email = () => `otp-${randomUUID().slice(0, 8)}@example.com`;
  const body = (over: Record<string, unknown> = {}) => ({
    email: email(),
    password: PASSWORD,
    fullName: 'Nguyễn Văn An',
    role: 'TENANT',
    ...over,
  });
  const register = (b: Record<string, unknown>) => x.t.http().post('/api/v1/auth/register').send(b);
  const login = (e: string, password = PASSWORD) =>
    x.t.http().post('/api/v1/auth/login').send({ email: e, password });
  const verify = (e: string, otp: string) =>
    x.t.http().post('/api/v1/auth/verify-otp').send({ email: e, otp });
  const resend = (e: string) => x.t.http().post('/api/v1/auth/resend-otp').send({ email: e });
  const row = async (e: string) =>
    (await x.pg.query(`SELECT * FROM users WHERE lower(email) = lower($1)`, [e])).rows[0];
  /** Một mã sai chắc chắn khác mã đúng. */
  const wrongOf = (otp: string) => (otp === '000000' ? '111111' : '000000');

  beforeAll(async () => {
    x = await startIdentityInfra();
  });
  afterAll(async () => {
    await x?.close();
  });

  describe('test 13: đăng ký', () => {
    it('201, status PENDING_VERIFICATION, phone lưu; transport nhận ĐÚNG MỘT email OTP từ MAIL_FROM', async () => {
      const b = body({ phone: '0912345678' });
      const res = await register(b);

      expect(res.status).toBe(201);
      expect(res.body.data).toMatchObject({
        email: b.email,
        status: 'PENDING_VERIFICATION',
        phone: '0912345678',
        role: 'TENANT',
      });
      const user = await row(b.email as string);
      expect(user).toMatchObject({ status: 'PENDING_VERIFICATION', email_verified_at: null });

      const mails = await waitForMails(b.email as string, 1);
      await new Promise((resolve) => setTimeout(resolve, 500));
      expect(await waitForMails(b.email as string, 1)).toHaveLength(1);
      expect(mails[0].from).toBe('no-reply@realestate.local');
      expect(mails[0].subject).toContain('xác minh');
      expect(otpOf(mails[0])).toMatch(/^\d{6}$/);
    });

    it('OTP trong Redis chỉ là hash, có TTL ~300 giây và cooldown ~60 giây; không có mã thật', async () => {
      const b = body();
      const id = (await register(b)).body.data.id as string;
      const otp = otpOf((await waitForMails(b.email as string))[0]);

      const key = `${x.redisPrefix}otp:${id}`;
      const stored = await x.redis.hgetall(key);
      expect(stored.attempts).toBe('0');
      expect(stored.otpHash).toMatch(/^[0-9a-f]{64}$/);
      expect(JSON.stringify(stored)).not.toContain(otp);
      expect(await x.redis.ttl(key)).toBeGreaterThan(290);
      expect(await x.redis.ttl(`${x.redisPrefix}otp-cooldown:${id}`)).toBeGreaterThan(50);
    });

    it('ghi identity.registered cùng transaction, đúng contract; password_hash không nằm trong response', async () => {
      const b = body();
      const res = await register(b);
      const events = (
        await x.pg.query(
          `SELECT envelope FROM outbox_events WHERE envelope->'payload'->>'userId' = $1`,
          [res.body.data.id],
        )
      ).rows;
      expect(events).toHaveLength(1);
      expect(() =>
        expectEventMatchesContract({ ...events[0].envelope, producer: 'identity' }),
      ).not.toThrow();
      expect(JSON.stringify(res.body)).not.toMatch(/password|argon2/i);
    });

    it('phone sai định dạng -> 400; phone trùng -> 409 IDENTITY_PHONE_TAKEN, không tạo user, không event', async () => {
      const first = body({ phone: '0987654321' });
      expect((await register(first)).status).toBe(201);

      expect((await register(body({ phone: '12345' }))).status).toBe(400);

      const second = body({ phone: '0987654321' });
      const res = await register(second);
      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe('IDENTITY_PHONE_TAKEN');
      expect(await row(second.email as string)).toBeUndefined();
      const events = await x.pg.query(
        `SELECT 1 FROM outbox_events WHERE envelope->'payload'->>'email' = $1`,
        [second.email],
      );
      expect(events.rowCount).toBe(0);
    });

    it('trùng email vẫn 409 IDENTITY_EMAIL_TAKEN (không nhầm với phone)', async () => {
      const b = body({ phone: '0911111111' });
      await register(b);
      const res = await register({
        ...b,
        email: (b.email as string).toUpperCase(),
        phone: '0922222222',
      });
      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe('IDENTITY_EMAIL_TAKEN');
    });

    it('hai người không khai phone vẫn đăng ký được (UQ_users_phone là chỉ mục có điều kiện)', async () => {
      expect((await register(body())).status).toBe(201);
      expect((await register(body())).status).toBe(201);
    });

    it('số truy vấn DB: đăng ký đúng 2 (INSERT users + INSERT outbox_events), dưới ngưỡng ghi 6', async () => {
      x.queries.length = 0;
      const res = await register(body());
      expect(res.status).toBe(201);
      // chờ việc nền (Redis, SMTP) xong để chắc chắn không có truy vấn DB nào thêm
      await new Promise((resolve) => setTimeout(resolve, 300));
      expect(x.queries).toHaveLength(2);
      expect(x.queries[0]).toMatch(/INSERT INTO "users"/);
      expect(x.queries[1]).toMatch(/INSERT INTO "outbox_events"|INSERT INTO outbox_events/i);
    });
  });

  describe('test 14: đăng nhập theo trạng thái', () => {
    it('đúng mật khẩu nhưng chưa xác minh -> 403 IDENTITY_EMAIL_NOT_VERIFIED, không có token', async () => {
      const b = body();
      await register(b);
      const res = await login(b.email as string);
      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe('IDENTITY_EMAIL_NOT_VERIFIED');
      expect(JSON.stringify(res.body)).not.toContain('accessToken');
    });

    it('SAI mật khẩu thì vẫn 401 IDENTITY_INVALID_CREDENTIALS (không lộ trạng thái)', async () => {
      const b = body();
      await register(b);
      const res = await login(b.email as string, 'Sai-mat-khau-1');
      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe('IDENTITY_INVALID_CREDENTIALS');
    });
  });

  describe('test 15: OTP đúng', () => {
    it('200 cặp token, DB ACTIVE + email_verified_at, /me dùng được, đăng nhập được, dùng lại OTP -> 400', async () => {
      const b = body();
      await register(b);
      const otp = otpOf((await waitForMails(b.email as string))[0]);

      const res = await verify((b.email as string).toUpperCase(), otp);

      expect(res.status).toBe(200);
      expect(res.body.data).toMatchObject({ tokenType: 'Bearer', expiresIn: 900 });
      expect(res.body.data.accessToken).toEqual(expect.any(String));
      expect(res.body.data.refreshToken).toEqual(expect.any(String));
      const user = await row(b.email as string);
      expect(user.status).toBe('ACTIVE');
      expect(user.email_verified_at).toBeInstanceOf(Date);

      const me = await x.t
        .http()
        .get('/api/v1/auth/me')
        .set('Authorization', `Bearer ${res.body.data.accessToken}`);
      expect(me.body.data).toMatchObject({ email: b.email, status: 'ACTIVE' });
      expect((await login(b.email as string)).status).toBe(200);

      const again = await verify(b.email as string, otp);
      expect(again.status).toBe(400);
      expect(again.body.error.code).toBe('IDENTITY_OTP_INVALID');
    });

    it('refresh token cấp ở verify-otp xoay vòng được như đăng nhập thường', async () => {
      const b = body();
      await register(b);
      const otp = otpOf((await waitForMails(b.email as string))[0]);
      const { refreshToken } = (await verify(b.email as string, otp)).body.data;
      const res = await x.t.http().post('/api/v1/auth/refresh').send({ refreshToken });
      expect(res.status).toBe(200);
    });

    it('số truy vấn DB: verify-otp đúng 2 (SELECT user, UPDATE), dưới ngưỡng ghi 6', async () => {
      const b = body();
      await register(b);
      const otp = otpOf((await waitForMails(b.email as string))[0]);
      x.queries.length = 0;
      expect((await verify(b.email as string, otp)).status).toBe(200);
      expect(x.queries).toHaveLength(2);
      expect(x.queries[0]).toMatch(/SELECT/i);
      expect(x.queries[1]).toMatch(/UPDATE "users"/);
    });

    it('hai verify-otp ĐỒNG THỜI cùng mã đúng: không thể có hai phiên cùng lúc thắng quá một lần ACTIVE', async () => {
      const b = body();
      await register(b);
      const otp = otpOf((await waitForMails(b.email as string))[0]);
      const results = await Promise.all([
        verify(b.email as string, otp),
        verify(b.email as string, otp),
      ]);
      const statuses = results.map((r) => r.status).sort();
      // Một bên thắng; bên kia 400 (hoặc cũng 200 nếu cả hai qua kiểm tra trước khi một bên xóa mã nhưng UPDATE chỉ đổi một dòng)
      expect(statuses).toContain(200);
      expect(statuses.filter((s) => s === 200).length).toBeLessThanOrEqual(1);
      expect(statuses.filter((s) => s === 400).length).toBeGreaterThanOrEqual(1);
    });

    it('verify-otp: DTO sai (OTP không đủ 6 chữ số, email sai) -> 400 VALIDATION_FAILED', async () => {
      for (const bad of [
        { email: 'a@b.com', otp: '12345' },
        { email: 'a@b.com', otp: 'abcdef' },
        { email: 'khong-phai-email', otp: '123456' },
        { email: 'a@b.com' },
      ]) {
        const res = await x.t.http().post('/api/v1/auth/verify-otp').send(bad);
        expect(res.status).toBe(400);
        expect(res.body.error.code).toBe('VALIDATION_FAILED');
      }
    });

    it('email không có tài khoản, hoặc tài khoản đã ACTIVE -> cùng 400 IDENTITY_OTP_INVALID', async () => {
      const unknown = await verify(email(), '123456');
      expect(unknown.status).toBe(400);
      expect(unknown.body.error.code).toBe('IDENTITY_OTP_INVALID');

      const b = body();
      await register(b);
      const otp = otpOf((await waitForMails(b.email as string))[0]);
      await verify(b.email as string, otp);
      const active = await verify(b.email as string, otp);
      expect(active.body).toMatchObject({ error: { code: 'IDENTITY_OTP_INVALID' } });
      expect(active.body.error.message).toBe(unknown.body.error.message);
    });
  });

  describe('test 16: OTP sai', () => {
    it('sai 5 lần thì lần 5 xóa mã; mã đúng sau đó vẫn 400 và tài khoản vẫn PENDING', async () => {
      const b = body();
      await register(b);
      const id = (await row(b.email as string)).id as string;
      const otp = otpOf((await waitForMails(b.email as string))[0]);

      for (let i = 1; i <= 5; i += 1) {
        const res = await verify(b.email as string, wrongOf(otp));
        expect(res.status).toBe(400);
        expect(res.body.error.code).toBe('IDENTITY_OTP_INVALID');
      }
      expect(await x.redis.exists(`${x.redisPrefix}otp:${id}`)).toBe(0);

      const res = await verify(b.email as string, otp);
      expect(res.status).toBe(400);
      expect((await row(b.email as string)).status).toBe('PENDING_VERIFICATION');
    });

    it('sai 4 lần rồi đúng ở lần 5: vẫn thành công (lần 5 chỉ hủy khi sai)', async () => {
      const b = body();
      await register(b);
      const otp = otpOf((await waitForMails(b.email as string))[0]);
      for (let i = 0; i < 4; i += 1) await verify(b.email as string, wrongOf(otp));
      expect((await verify(b.email as string, otp)).status).toBe(200);
    });

    it('20 lần thử SONG SONG (1 đúng + 19 sai): không quá 5 lần được so; mã đúng không "may mắn" lọt sau khi hủy', async () => {
      const b = body();
      await register(b);
      const id = (await row(b.email as string)).id as string;
      const otp = otpOf((await waitForMails(b.email as string))[0]);
      const tries = Array.from({ length: 20 }, (_, i) =>
        verify(b.email as string, i === 19 ? otp : wrongOf(otp)),
      );
      const results = await Promise.all(tries);

      const ok = results.filter((r) => r.status === 200).length;
      expect(ok).toBeLessThanOrEqual(1);
      expect(results.every((r) => r.status === 200 || r.status === 400)).toBe(true);
      // Còn thử thêm được tối đa 5 lần trong tổng số: attempts không bao giờ vượt 5 trong hash còn sống
      const attempts = await x.redis.hget(`${x.redisPrefix}otp:${id}`, 'attempts');
      expect(attempts === null || Number(attempts) <= 5).toBe(true);
    });
  });

  describe('test 17: gửi lại OTP', () => {
    it('ngay sau đăng ký -> 429 IDENTITY_OTP_RESEND_TOO_SOON, không có thư thứ hai', async () => {
      const b = body();
      await register(b);
      await waitForMails(b.email as string, 1);

      const res = await resend(b.email as string);

      expect(res.status).toBe(429);
      expect(res.body.error.code).toBe('IDENTITY_OTP_RESEND_TOO_SOON');
      await new Promise((resolve) => setTimeout(resolve, 500));
      expect(await waitForMails(b.email as string, 1)).toHaveLength(1);
    });

    it('hết thời gian chờ -> 202, thư mới có OTP mới; mã cũ không dùng được nữa, số lần sai đặt lại', async () => {
      const b = body();
      await register(b);
      const id = (await row(b.email as string)).id as string;
      const oldOtp = otpOf((await waitForMails(b.email as string))[0]);
      await verify(b.email as string, wrongOf(oldOtp)); // attempts = 1
      await x.redis.del(`${x.redisPrefix}otp-cooldown:${id}`); // coi như đã qua 60 giây

      const res = await resend((b.email as string).toUpperCase());
      expect(res.status).toBe(202);

      const mails = await waitForMails(b.email as string, 2);
      const codes = mails.map(otpOf);
      const newOtp = codes.find((c) => c !== oldOtp) ?? codes[0];
      expect(await x.redis.hget(`${x.redisPrefix}otp:${id}`, 'attempts')).toBe('0');
      if (newOtp !== oldOtp) {
        expect((await verify(b.email as string, oldOtp)).status).toBe(400);
      }
      expect((await verify(b.email as string, newOtp)).status).toBe(200);
    });

    it('email không tồn tại, hoặc đã ACTIVE -> 202, KHÔNG gửi thư (không lộ email)', async () => {
      const unknown = email();
      expect((await resend(unknown)).status).toBe(202);
      await expectNoMail(unknown);

      const b = body();
      await register(b);
      const otp = otpOf((await waitForMails(b.email as string))[0]);
      await verify(b.email as string, otp);
      expect((await resend(b.email as string)).status).toBe(202);
      await new Promise((resolve) => setTimeout(resolve, 500));
      expect(await waitForMails(b.email as string, 1)).toHaveLength(1);
    });

    it('resend-otp: email sai định dạng -> 400', async () => {
      const res = await x.t
        .http()
        .post('/api/v1/auth/resend-otp')
        .send({ email: 'khong-phai-email' });
      expect(res.status).toBe(400);
    });
  });

  describe('Redis dừng (kiểm trước khi ghi DB)', () => {
    it('đăng ký khi Redis không sẵn sàng -> 503 DEPENDENCY_UNAVAILABLE và KHÔNG tạo user', async () => {
      const b = body();
      // Mô phỏng Redis không sẵn sàng bằng cách làm client của app mất kết nối tạm thời
      const { RedisService } = await import('../src/redis/redis.service');
      const client = x.t.app.get(RedisService).client;
      const ready = client.status;
      expect(ready).toBe('ready');
      client.disconnect();
      try {
        const res = await register(b);
        expect(res.status).toBe(503);
        expect(res.body.error.code).toBe('DEPENDENCY_UNAVAILABLE');
        expect(await row(b.email as string)).toBeUndefined();
      } finally {
        await client.connect().catch(() => undefined);
      }
    });
  });
});
