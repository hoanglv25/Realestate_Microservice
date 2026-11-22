import { checkRentalEnv } from './rental.env';

const full = {
  DATABASE_URL: 'postgres://rental_user:x@localhost:5433/rental_db',
  REDIS_URL: 'redis://:x@localhost:6379',
  RABBITMQ_URL: 'amqp://u:p@localhost:5672/',
  INTERNAL_LISTING_URL: 'http://localhost:3002',
  INTERNAL_PAYMENT_URL: 'http://localhost:3004',
  JWT_ISSUER: 'realestate-identity',
  JWT_PUBLIC_KEY_PATH: '../../secrets/jwt-public.pem',
};

describe('checkRentalEnv', () => {
  it('đủ biến: không lỗi; JWT_PUBLIC_KEY thay được JWT_PUBLIC_KEY_PATH', () => {
    expect(checkRentalEnv(full)).toEqual([]);
    const rest: Record<string, unknown> = { ...full };
    delete rest.JWT_PUBLIC_KEY_PATH;
    expect(checkRentalEnv({ ...rest, JWT_PUBLIC_KEY: '-----BEGIN PUBLIC KEY-----' })).toEqual([]);
  });

  it.each([
    'DATABASE_URL',
    'REDIS_URL',
    'RABBITMQ_URL',
    'INTERNAL_LISTING_URL',
    'INTERNAL_PAYMENT_URL',
    'JWT_ISSUER',
  ])('thiếu %s (hoặc chỉ có khoảng trắng): báo đúng tên biến', (name) => {
    const env: Record<string, unknown> = { ...full, [name]: '  ' };
    const errors = checkRentalEnv(env);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain(name);
  });

  it('thiếu cả hai khóa JWT: nói cần MỘT trong hai', () => {
    const rest: Record<string, unknown> = { ...full };
    delete rest.JWT_PUBLIC_KEY_PATH;
    const [error] = checkRentalEnv(rest);
    expect(error).toContain('JWT_PUBLIC_KEY');
    expect(error).toContain('JWT_PUBLIC_KEY_PATH');
  });

  it('không in giá trị biến (URL có mật khẩu)', () => {
    const errors = checkRentalEnv({ REDIS_URL: 'redis://:bi-mat-xyz@localhost:6379' });
    expect(errors.join('\n')).not.toContain('bi-mat-xyz');
  });
});
