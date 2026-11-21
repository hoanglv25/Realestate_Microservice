import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

/**
 * Chạy env.bootstrap.ts như một tiến trình riêng (giống lúc `node dist/main.js` khởi động) để
 * chứng minh: thiếu/sai biến thì tiến trình DỪNG NGAY với mã 1 và thông báo rõ, không in stack.
 */
const bootstrap = resolve(__dirname, 'env.bootstrap.ts');
const tsconfig = resolve(__dirname, '../../tsconfig.json');
const tsNode = require.resolve('ts-node/register/transpile-only');

function run(env: Record<string, string>) {
  const cwd = mkdtempSync(join(tmpdir(), 'bootstrap-')); // thư mục trống: không có file .env
  const baseEnv = { ...process.env } as Record<string, string | undefined>;
  for (const key of Object.keys(baseEnv)) {
    if (
      /^(SERVICE_NAME|PORT|LOG_LEVEL|REDIS_URL|DATABASE_URL|JWT_.*|HTTP_.*|NODE_ENV|RABBITMQ_.*|INTERNAL_.*)$/.test(
        key,
      )
    ) {
      delete baseEnv[key];
    }
  }
  try {
    return spawnSync(process.execPath, ['-r', tsNode, bootstrap], {
      cwd,
      env: { ...baseEnv, TS_NODE_PROJECT: tsconfig, ...env },
      encoding: 'utf8',
      timeout: 60_000,
    });
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
}

describe('env.bootstrap (khởi động tiến trình)', () => {
  it('thiếu SERVICE_NAME -> thoát mã 1 và báo rõ thiếu biến nào, không in stack trace', () => {
    const r = run({});
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('Cấu hình môi trường không hợp lệ');
    expect(r.stderr).toContain('SERVICE_NAME: THIẾU (bắt buộc)');
    expect(r.stderr).not.toMatch(/\n\s+at /);
  });

  it('nhiều biến sai -> liệt kê hết, vẫn thoát mã 1', () => {
    const r = run({ SERVICE_NAME: 'x', PORT: 'abc', REDIS_URL: 'http://sai' });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('PORT');
    expect(r.stderr).toContain('REDIS_URL');
  });

  it('NODE_ENV=test bỏ qua phần bắt buộc riêng của rental -> thoát mã 0, không in lỗi', () => {
    const r = run({ SERVICE_NAME: 'x', NODE_ENV: 'test' });
    expect(r.status).toBe(0);
    expect(r.stderr).toBe('');
  });

  it('rental thiếu DB, Redis, RabbitMQ, URL nội bộ, JWT -> thoát mã 1 và liệt kê từng thứ thiếu', () => {
    const r = run({ SERVICE_NAME: 'rental' });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('Thiếu cấu hình của rental-service');
    for (const name of [
      'DATABASE_URL',
      'REDIS_URL',
      'RABBITMQ_URL',
      'INTERNAL_LISTING_URL',
      'INTERNAL_PAYMENT_URL',
      'JWT_ISSUER',
      'JWT_PUBLIC_KEY',
    ]) {
      expect(r.stderr).toContain(name);
    }
  });

  it('rental đủ cấu hình -> thoát mã 0', () => {
    const r = run({
      SERVICE_NAME: 'rental',
      DATABASE_URL: 'postgres://u:p@localhost:5433/rental_db',
      REDIS_URL: 'redis://:p@localhost:6379',
      RABBITMQ_URL: 'amqp://u:p@localhost:5672/',
      INTERNAL_LISTING_URL: 'http://localhost:3002',
      INTERNAL_PAYMENT_URL: 'http://localhost:3004',
      JWT_ISSUER: 'realestate-identity',
      JWT_PUBLIC_KEY_PATH: '../../secrets/jwt-public.pem',
    });
    expect(r.stderr).toBe('');
    expect(r.status).toBe(0);
  });
});
