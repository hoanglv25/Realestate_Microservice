import { validateEnv } from './env.validation';

describe('validateEnv', () => {
  it('thiếu SERVICE_NAME -> ném lỗi nói rõ biến nào thiếu', () => {
    expect(() => validateEnv({})).toThrow(/SERVICE_NAME: THIẾU \(bắt buộc\)/);
  });

  it('liệt kê TẤT CẢ biến sai một lượt, không dừng ở biến đầu tiên', () => {
    let message = '';
    try {
      validateEnv({ PORT: 'abc', LOG_LEVEL: 'ồn ào', REDIS_URL: 'http://sai', JWT_SECRET: 'ngan' });
    } catch (e) {
      message = (e as Error).message;
    }
    for (const name of ['SERVICE_NAME', 'PORT', 'LOG_LEVEL', 'REDIS_URL', 'JWT_SECRET']) {
      expect(message).toContain(name);
    }
  });

  it('áp mặc định đúng cho biến không bắt buộc', () => {
    expect(validateEnv({ SERVICE_NAME: 'identity' })).toMatchObject({
      NODE_ENV: 'development',
      PORT: 3000,
      LOG_LEVEL: 'info',
      LOG_PRETTY: false,
      HTTP_TIMEOUT_MS: 3000,
      HTTP_MAX_RETRIES: 2,
      SWAGGER_ENABLED: true,
      IDEMPOTENCY_TTL_SECONDS: 86400,
    });
  });

  it('biến tùy chọn để trống được coi như không đặt (module tương ứng tắt)', () => {
    const env = validateEnv({ SERVICE_NAME: 'x', DATABASE_URL: '', REDIS_URL: '   ' });
    expect(env.DATABASE_URL).toBeUndefined();
    expect(env.REDIS_URL).toBeUndefined();
  });

  it('chấp nhận URL hợp lệ và từ chối sai scheme', () => {
    const ok = validateEnv({
      SERVICE_NAME: 'x',
      DATABASE_URL: 'postgres://u:p@localhost:5433/db',
      REDIS_URL: 'redis://:pw@localhost:6379',
      RABBITMQ_URL: 'amqp://u:p@localhost:5672/%2F',
    });
    expect(ok.DATABASE_URL).toContain('postgres://');
    expect(() => validateEnv({ SERVICE_NAME: 'x', DATABASE_URL: 'mysql://u@h/db' })).toThrow(
      /DATABASE_URL/,
    );
  });

  it('RABBITMQ_URL bắt buộc đi kèm DATABASE_URL (outbox/inbox nằm trong DB)', () => {
    expect(() => validateEnv({ SERVICE_NAME: 'x', RABBITMQ_URL: 'amqp://u:p@h:5672/%2F' })).toThrow(
      /DATABASE_URL: THIẾU \(bắt buộc khi có RABBITMQ_URL\)/,
    );
    const env = validateEnv({
      SERVICE_NAME: 'x',
      RABBITMQ_URL: 'amqp://u:p@h:5672/%2F',
      DATABASE_URL: 'postgres://u:p@h:5433/db',
    });
    expect(env).toMatchObject({
      RABBITMQ_EXCHANGE: 'domain.events',
      RABBITMQ_PREFETCH: 10,
      RABBITMQ_MAX_RETRIES: 3,
      OUTBOX_POLL_INTERVAL_MS: 1000,
      OUTBOX_BATCH_SIZE: 50,
    });
    expect(env.RABBITMQ_QUEUE).toBeUndefined();
  });

  it('OUTBOX_RELAY_ENABLED mặc định true, đặt false để chỉ ghi outbox (C18)', () => {
    expect(validateEnv({ SERVICE_NAME: 'x' }).OUTBOX_RELAY_ENABLED).toBe(true);
    expect(validateEnv({ SERVICE_NAME: 'x', OUTBOX_RELAY_ENABLED: 'false' })).toMatchObject({
      OUTBOX_RELAY_ENABLED: false,
    });
    expect(() => validateEnv({ SERVICE_NAME: 'x', OUTBOX_RELAY_ENABLED: 'có' })).toThrow(
      /OUTBOX_RELAY_ENABLED/,
    );
  });

  it('S3_ENDPOINT bắt buộc kèm khóa; S3_BUCKETS tách thành mảng và kiểm tra tên', () => {
    expect(() => validateEnv({ SERVICE_NAME: 'x', S3_ENDPOINT: 'http://localhost:9000' })).toThrow(
      /S3_ACCESS_KEY: THIẾU \(bắt buộc khi có S3_ENDPOINT\)/,
    );
    const base = {
      SERVICE_NAME: 'x',
      S3_ENDPOINT: 'http://localhost:9000',
      S3_ACCESS_KEY: 'k',
      S3_SECRET_KEY: 's',
    };
    expect(validateEnv({ ...base, S3_BUCKETS: ' listing-images, bank-qr ' })).toMatchObject({
      S3_BUCKETS: ['listing-images', 'bank-qr'],
      S3_REGION: 'us-east-1',
      S3_FORCE_PATH_STYLE: true,
      S3_PRESIGN_TTL_SECONDS: 900,
    });
    expect(validateEnv(base).S3_BUCKETS).toEqual([]);
    expect(() => validateEnv({ ...base, S3_BUCKETS: 'Anh_Phong' })).toThrow(/'Anh_Phong'/);
  });

  describe('biến của T2.5 (SMTP, OTP, đặt lại mật khẩu, Google)', () => {
    it('áp mặc định theo API_Spec §5', () => {
      expect(validateEnv({ SERVICE_NAME: 'identity' })).toMatchObject({
        SMTP_PORT: 587, // C27: không còn Mailpit (1025), mặc định cổng SMTP chuẩn có STARTTLS
        OTP_TTL_SECONDS: 300,
        OTP_MAX_ATTEMPTS: 5,
        OTP_RESEND_COOLDOWN_SECONDS: 60,
        PASSWORD_RESET_TTL_SECONDS: 900,
        PASSWORD_RESET_URL: 'http://localhost:3000/reset-password',
      });
    });

    it('SMTP_HOST, SMTP_USER, SMTP_PASSWORD, MAIL_FROM, GOOGLE_CLIENT_ID để trống = không đặt', () => {
      const env = validateEnv({
        SERVICE_NAME: 'identity',
        SMTP_HOST: '',
        SMTP_USER: '',
        SMTP_PASSWORD: '',
        MAIL_FROM: '',
        GOOGLE_CLIENT_ID: '',
      });
      expect(env.SMTP_HOST).toBeUndefined();
      expect(env.SMTP_USER).toBeUndefined();
      expect(env.SMTP_PASSWORD).toBeUndefined();
      expect(env.MAIL_FROM).toBeUndefined();
      expect(env.GOOGLE_CLIENT_ID).toBeUndefined();
    });

    it('chấp nhận giá trị hợp lệ và từ chối số ngoài khoảng', () => {
      expect(
        validateEnv({
          SERVICE_NAME: 'identity',
          SMTP_PORT: '587',
          OTP_MAX_ATTEMPTS: '3',
          GOOGLE_CLIENT_ID: 'abc.apps.googleusercontent.com',
        }),
      ).toMatchObject({
        SMTP_PORT: 587,
        OTP_MAX_ATTEMPTS: 3,
        GOOGLE_CLIENT_ID: 'abc.apps.googleusercontent.com',
      });
      for (const bad of [
        { SMTP_PORT: '0' },
        { OTP_TTL_SECONDS: '5' },
        { OTP_MAX_ATTEMPTS: '0' },
        { OTP_RESEND_COOLDOWN_SECONDS: '-1' },
        { PASSWORD_RESET_TTL_SECONDS: '10' },
        { PASSWORD_RESET_URL: 'khong-phai-url' },
      ]) {
        expect(() => validateEnv({ SERVICE_NAME: 'identity', ...bad })).toThrow(
          new RegExp(Object.keys(bad)[0]),
        );
      }
    });
  });

  it('JWT_SECRET phải đủ dài (>= 16 ký tự)', () => {
    expect(() => validateEnv({ SERVICE_NAME: 'x', JWT_SECRET: 'ngan' })).toThrow(/JWT_SECRET/);
    expect(
      validateEnv({ SERVICE_NAME: 'x', JWT_SECRET: 'du-dai-muoi-sau-ky-tu' }).JWT_SECRET,
    ).toBeDefined();
  });
});
