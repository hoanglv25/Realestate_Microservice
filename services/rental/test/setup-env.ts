// Chạy trước mỗi file test e2e, TRƯỚC khi AppModule được import:
// đặt env test cố định và xóa biến tùy chọn để test không phụ thuộc môi trường của máy.
process.env.NODE_ENV = 'test';
process.env.SERVICE_NAME = 'template-nest-test';
process.env.LOG_LEVEL = 'info';
process.env.LOG_PRETTY = 'false';
process.env.SWAGGER_ENABLED = 'false';

for (const name of [
  'DATABASE_URL',
  'REDIS_URL',
  'RABBITMQ_URL',
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
