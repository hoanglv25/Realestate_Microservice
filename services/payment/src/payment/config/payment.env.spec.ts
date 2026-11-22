import { checkPaymentEnv } from './payment.env';

const full = {
  DATABASE_URL: 'postgres://payment_user:x@localhost:5433/payment_db',
  RABBITMQ_URL: 'amqp://u:p@localhost:5672/',
  PAYOS_CLIENT_ID: 'client-id',
  PAYOS_API_KEY: 'api-key',
  PAYOS_CHECKSUM_KEY: 'checksum-key',
  JWT_ISSUER: 'realestate-identity',
  JWT_PUBLIC_KEY_PATH: '../../secrets/jwt-public.pem',
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
  ])('thiếu %s: báo đúng tên biến', (name) => {
    const env: Record<string, unknown> = { ...full };
    delete env[name];
    const errors = checkPaymentEnv(env);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain(name);
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
