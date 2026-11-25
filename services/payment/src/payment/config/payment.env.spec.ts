import { checkPaymentEnv } from './payment.env';

const full = {
  DATABASE_URL: 'postgres://payment_user:x@localhost:5433/payment_db',
  RABBITMQ_URL: 'amqp://u:p@localhost:5672/',
  PAYOS_CLIENT_ID: 'client-id',
  PAYOS_API_KEY: 'api-key',
  PAYOS_CHECKSUM_KEY: 'checksum-key',
  JWT_ISSUER: 'realestate-identity',
  JWT_PUBLIC_KEY_PATH: '../../secrets/jwt-public.pem',
  // T3.6 (RE.PAYOUT §6, B2): Idempotency-Key, chứng từ S3, gọi rental và identity
  REDIS_URL: 'redis://:x@localhost:6379',
  S3_ENDPOINT: 'http://localhost:9000',
  S3_ACCESS_KEY: 'minio_admin',
  S3_SECRET_KEY: 'change_me_minio',
  S3_BUCKETS: 'bank-qr,payment-proofs',
  INTERNAL_RENTAL_URL: 'http://localhost:3003',
  INTERNAL_IDENTITY_URL: 'http://localhost:3001',
};

describe('checkPaymentEnv', () => {
  it('đủ biến: không có lỗi', () => {
    expect(checkPaymentEnv(full)).toEqual([]);
  });

  it('chấp nhận JWT_PUBLIC_KEY thay cho JWT_PUBLIC_KEY_PATH', () => {
    const rest: Record<string, unknown> = { ...full };
    delete rest.JWT_PUBLIC_KEY_PATH;
    expect(checkPaymentEnv({ ...rest, JWT_PUBLIC_KEY: '-----BEGIN PUBLIC KEY-----' })).toEqual([]);
  });

  // RABBITMQ_URL (T3.4a): webhook phát payment.deposited qua outbox
  it.each([
    'DATABASE_URL',
    'RABBITMQ_URL',
    'PAYOS_CLIENT_ID',
    'PAYOS_API_KEY',
    'PAYOS_CHECKSUM_KEY',
    'JWT_ISSUER',
    'REDIS_URL',
    'S3_ENDPOINT',
    'S3_ACCESS_KEY',
    'S3_SECRET_KEY',
    'S3_BUCKETS',
    'INTERNAL_RENTAL_URL',
    'INTERNAL_IDENTITY_URL',
  ])('thiếu %s: báo đúng tên biến', (name) => {
    const env: Record<string, unknown> = { ...full };
    delete env[name];
    const errors = checkPaymentEnv(env);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain(name);
  });

  it('S3_BUCKETS phải có payment-proofs (bucket chứng từ, BR-17)', () => {
    const errors = checkPaymentEnv({ ...full, S3_BUCKETS: 'listing-images, bank-qr' });
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('S3_BUCKETS');
    expect(errors[0]).toContain('payment-proofs');
    expect(checkPaymentEnv({ ...full, S3_BUCKETS: ' payment-proofs ' })).toEqual([]);
  });

  it('chuỗi rỗng hoặc toàn khoảng trắng coi như thiếu', () => {
    const errors = checkPaymentEnv({ ...full, PAYOS_API_KEY: '   ', PAYOS_CHECKSUM_KEY: '' });
    expect(errors.join('\n')).toContain('PAYOS_API_KEY');
    expect(errors.join('\n')).toContain('PAYOS_CHECKSUM_KEY');
  });

  it('thiếu cả JWT_PUBLIC_KEY lẫn JWT_PUBLIC_KEY_PATH: nói cần MỘT trong hai', () => {
    const rest: Record<string, unknown> = { ...full };
    delete rest.JWT_PUBLIC_KEY_PATH;
    const errors = checkPaymentEnv(rest);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('JWT_PUBLIC_KEY');
    expect(errors[0]).toContain('JWT_PUBLIC_KEY_PATH');
  });

  it('không in giá trị của biến (khóa payOS là bí mật)', () => {
    const errors = checkPaymentEnv({ DATABASE_URL: 'postgres://x', PAYOS_API_KEY: 'bi-mat-123' });
    expect(errors.join('\n')).not.toContain('bi-mat-123');
  });
});
