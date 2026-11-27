// Chạy trước mỗi file test hạ tầng (pnpm test:infra), TRƯỚC khi AppModule được import.
// Cần hạ tầng đang chạy: ở thư mục gốc repo `pnpm infra:up`.
//
// Đọc mật khẩu từ .env GỐC repo (không hard-code). Test dùng rental_db nhưng trong schema riêng
// INFRA_TEST_SCHEMA (search_path), tạo mới đầu test và xóa ở cuối, không đụng bảng của rental.
import { INFRA_TEST_SCHEMA, readRootEnv } from './helpers/infra';

// Chỉ ĐỌC .env gốc, không nạp vào process.env (tránh biến lạ lọt vào service đang test)
const root = readRootEnv();
const need = (name: string): string => {
  const v = root[name];
  if (!v) throw new Error(`Thiếu ${name} trong .env gốc`);
  return encodeURIComponent(v);
};

const databaseUrl =
  `postgres://${need('RENTAL_DB_USER')}:${need('RENTAL_DB_PASSWORD')}` +
  `@localhost:${need('POSTGRES_PORT')}/${need('RENTAL_DB_NAME')}` +
  `?options=${encodeURIComponent(`-c search_path=${INFRA_TEST_SCHEMA}`)}`;
const rabbitUrl =
  `amqp://${need('RABBITMQ_USER')}:${need('RABBITMQ_PASSWORD')}` +
  `@localhost:${need('RABBITMQ_PORT')}/${encodeURIComponent(root.RABBITMQ_VHOST ?? '/')}`;

Object.assign(process.env, {
  NODE_ENV: 'test',
  SERVICE_NAME: 'template-nest-test',
  LOG_LEVEL: 'info',
  LOG_PRETTY: 'false',
  SWAGGER_ENABLED: 'false',
  DATABASE_URL: databaseUrl,
  RABBITMQ_URL: rabbitUrl,
  // Các job không tự chạy trong test hạ tầng: test gọi runOnce() đúng lúc cần (T3.3, T3.4b, T3.5)
  SAGA_RECONCILE_INTERVAL_MS: '0',
  HOLD_EXPIRY_INTERVAL_MS: '0',
  AUTO_RELEASE_INTERVAL_MS: '0',
  DEADLINE_INTERVAL_MS: '0',
});
// S3 do storage.infra-spec.ts tự bật khi .env gốc có cấu hình R2 (để test messaging không có thêm check 's3')
for (const name of [
  'REDIS_URL',
  'RABBITMQ_QUEUE',
  'S3_ENDPOINT',
  'S3_PUBLIC_ENDPOINT',
  'S3_ACCESS_KEY',
  'S3_SECRET_KEY',
  'S3_BUCKETS',
  'JWT_PUBLIC_KEY',
  'JWT_PUBLIC_KEY_PATH',
  'JWT_SECRET',
  'JWT_ISSUER',
]) {
  delete process.env[name];
}
