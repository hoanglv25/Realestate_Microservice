import { createHash, randomUUID } from 'node:crypto';
import { startIdentityInfra } from './helpers/identity-infra';
import type { IdentityInfra } from './helpers/identity-infra';
import { expectNoMail, otpOf, resetTokenOf, waitForMails } from './helpers/mail-capture';

/**
 * Quên mật khẩu, đặt lại mật khẩu: test 18, 19 của `Component_Class_Design §5`, với Postgres + Redis THẬT;
 * email bắt bằng transport giả (`helpers/mail-capture.ts`, C27).
 */
describe('Quên và đặt lại mật khẩu với hạ tầng thật', () => {
  let x: IdentityInfra;
  const PASSWORD = 'Mat-khau-du-dai-1';
  const NEW_PASSWORD = 'Mat-khau-moi-9999';
  const email = () => `pw-${randomUUID().slice(0, 8)}@example.com`;
  const forgot = (e: string) => x.t.http().post('/api/v1/auth/forgot-password').send({ email: e });
  const reset = (token: string, newPassword = NEW_PASSWORD) =>
    x.t.http().post('/api/v1/auth/reset-password').send({ token, newPassword });
  const login = (e: string, password: string) =>
    x.t.http().post('/api/v1/auth/login').send({ email: e, password });

  /** Tạo tài khoản ACTIVE (qua API rồi SQL, luồng OTP đã test ở otp.infra-spec.ts). */
  async function activeUser(status: 'ACTIVE' | 'PENDING_VERIFICATION' = 'ACTIVE') {
    const e = email();
    const res = await x.t
      .http()
      .post('/api/v1/auth/register')
      .send({ email: e, password: PASSWORD, fullName: 'Nguyễn Văn An', role: 'TENANT' });
    await x.pg.query(
      `UPDATE users SET status = $2, email_verified_at = CASE WHEN $2 = 'ACTIVE' THEN now() END WHERE id = $1`,
      [res.body.data.id, status],
    );
    return { email: e, id: res.body.data.id as string };
  }

  beforeAll(async () => {
    x = await startIdentityInfra();
  });
  afterAll(async () => {
    await x?.close();
  });

  describe('test 18: quên mật khẩu', () => {
    it('email không tồn tại -> 202 và KHÔNG gửi thư, KHÔNG có token trong Redis', async () => {
      const unknown = email();
      const res = await forgot(unknown);
      expect(res.status).toBe(202);
      await expectNoMail(unknown);
      expect(await x.redis.keys(`${x.redisPrefix}pwreset:*`)).toHaveLength(0);
    });

    it('có tài khoản -> 202 (cùng dạng response), thư có link PASSWORD_RESET_URL?token=...; Redis chỉ giữ hash, TTL ~900 giây', async () => {
      const u = await activeUser();
      const unknownRes = await forgot(email());
      const res = await forgot(u.email.toUpperCase());

      expect(res.status).toBe(202);
      expect(res.body).toEqual({ ...unknownRes.body, meta: res.body.meta });

      const mails = await waitForMails(u.email, 2); // OTP đăng ký + link đặt lại (chờ 1 thư thì có lúc chỉ thấy thư OTP)
      const forgotMail = mails.find((m) => m.subject.toLowerCase().includes('đặt lại mật khẩu'))!;
      expect(forgotMail.text).toContain('http://localhost:3000/reset-password?token=');
      const token = resetTokenOf(forgotMail);

      const keys = await x.redis.keys(`${x.redisPrefix}pwreset:*`);
      expect(keys.join()).not.toContain(token);
      const key = keys.find((k) => k.endsWith(createHash('sha256').update(token).digest('hex')))!;
      expect(await x.redis.get(key)).toBe(u.id);
      expect(await x.redis.ttl(key)).toBeGreaterThan(890);
    });

    it('tài khoản bị khóa -> 202, KHÔNG gửi thêm thư (chỉ còn thư OTP lúc đăng ký)', async () => {
      const u = await activeUser();
      await waitForMails(u.email, 1); // thư OTP của lần đăng ký
      await x.pg.query(`UPDATE users SET status = 'LOCKED' WHERE id = $1`, [u.id]);

      expect((await forgot(u.email)).status).toBe(202);

      await new Promise((resolve) => setTimeout(resolve, 600));
      expect(await waitForMails(u.email, 1)).toHaveLength(1);
    });

    it('tài khoản chưa xác minh vẫn nhận được link', async () => {
      const u = await activeUser('PENDING_VERIFICATION');
      expect((await forgot(u.email)).status).toBe(202);
      const mails = await waitForMails(u.email, 2); // OTP đăng ký + link đặt lại
      expect(mails.some((m) => m.text.includes('reset-password?token='))).toBe(true);
    });

    it('email sai định dạng -> 400', async () => {
      const res = await x.t
        .http()
        .post('/api/v1/auth/forgot-password')
        .send({ email: 'khong-phai' });
      expect(res.status).toBe(400);
    });

    it('số truy vấn DB: đúng 1 (SELECT user)', async () => {
      const u = await activeUser();
      x.queries.length = 0;
      await forgot(u.email);
      await waitForMails(u.email, 2).catch(() => undefined);
      expect(x.queries).toHaveLength(1);
    });
  });

  describe('test 19: đặt lại mật khẩu', () => {
    async function requestToken(u: { email: string }) {
      await forgot(u.email);
      const mails = await waitForMails(u.email, 2);
      return resetTokenOf(mails.find((m) => m.text.includes('reset-password?token='))!);
    }

    it('lần 1: 204, mật khẩu đổi (cũ 401, mới 200), refresh token cũ 401; lần 2 cùng token 400', async () => {
      const u = await activeUser();
      const session = (await login(u.email, PASSWORD)).body.data;
      const token = await requestToken(u);

      const first = await reset(token);
      expect(first.status).toBe(204);
      expect(first.text).toBe('');

      expect((await login(u.email, PASSWORD)).status).toBe(401);
      expect((await login(u.email, NEW_PASSWORD)).status).toBe(200);
      const refreshed = await x.t
        .http()
        .post('/api/v1/auth/refresh')
        .send({ refreshToken: session.refreshToken });
      expect(refreshed.status).toBe(401);
      expect(refreshed.body.error.code).toBe('IDENTITY_INVALID_REFRESH_TOKEN');

      const second = await reset(token, 'Mat-khau-khac-77777');
      expect(second.status).toBe(400);
      expect(second.body.error.code).toBe('IDENTITY_RESET_TOKEN_INVALID');
      expect((await login(u.email, NEW_PASSWORD)).status).toBe(200); // lần 2 không đổi gì
    });

    it('thu hồi MỌI phiên: hai lần đăng nhập (hai họ) đều bị thu hồi', async () => {
      const u = await activeUser();
      const a = (await login(u.email, PASSWORD)).body.data;
      const b = (await login(u.email, PASSWORD)).body.data;
      await reset(await requestToken(u));
      for (const s of [a, b]) {
        const res = await x.t
          .http()
          .post('/api/v1/auth/refresh')
          .send({ refreshToken: s.refreshToken });
        expect(res.status).toBe(401);
      }
    });

    it('token lạ -> 400 IDENTITY_RESET_TOKEN_INVALID', async () => {
      const res = await reset('khong-phai-token-that');
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('IDENTITY_RESET_TOKEN_INVALID');
    });

    it('token hết hạn (xóa khỏi Redis) -> 400', async () => {
      const u = await activeUser();
      const token = await requestToken(u);
      const keys = await x.redis.keys(`${x.redisPrefix}pwreset:*`);
      for (const key of keys) if ((await x.redis.get(key)) === u.id) await x.redis.del(key);
      expect((await reset(token)).status).toBe(400);
    });

    it('mật khẩu mới không đạt luật (ngắn) -> 400 VALIDATION_FAILED và token CHƯA bị tiêu', async () => {
      const u = await activeUser();
      const token = await requestToken(u);
      const bad = await reset(token, 'ngan');
      expect(bad.status).toBe(400);
      expect(bad.body.error.code).toBe('VALIDATION_FAILED');
      expect((await reset(token)).status).toBe(204);
    });

    it('10 reset ĐỒNG THỜI cùng token: đúng một cái 204, còn lại 400 (GETDEL nguyên tử)', async () => {
      const u = await activeUser();
      const token = await requestToken(u);
      const results = await Promise.all(Array.from({ length: 10 }, () => reset(token)));
      expect(results.filter((r) => r.status === 204)).toHaveLength(1);
      expect(results.filter((r) => r.status === 400)).toHaveLength(9);
    });

    it('đặt lại mật khẩu không tự xác minh email: tài khoản PENDING vẫn không đăng nhập được', async () => {
      const u = await activeUser('PENDING_VERIFICATION');
      await forgot(u.email);
      const mails = await waitForMails(u.email, 2);
      const token = resetTokenOf(mails.find((m) => m.text.includes('reset-password?token='))!);
      expect((await reset(token)).status).toBe(204);
      const res = await login(u.email, NEW_PASSWORD);
      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe('IDENTITY_EMAIL_NOT_VERIFIED');
      expect(
        otpOf(mails.find((m) => /\b\d{6}\b/.test(m.text) && !m.text.includes('token='))!),
      ).toMatch(/^\d{6}$/);
    });

    it('số truy vấn DB: reset đúng 1 (UPDATE users)', async () => {
      const u = await activeUser();
      const token = await requestToken(u);
      x.queries.length = 0;
      expect((await reset(token)).status).toBe(204);
      expect(x.queries).toHaveLength(1);
      expect(x.queries[0]).toMatch(/UPDATE "users"/);
    });
  });
});
