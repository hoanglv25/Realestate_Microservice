// Module tùy chọn chỉ bật khi có biến môi trường tương ứng.
// Đọc process.env lúc import AppModule (env đã được nạp/validate bởi env.bootstrap.ts hoặc ConfigModule).
const has = (name: string): boolean => Boolean(process.env[name]?.trim());

export const isDatabaseEnabled = (): boolean => has('DATABASE_URL');
export const isRedisEnabled = (): boolean => has('REDIS_URL');
// RabbitMQ cần DB (outbox/inbox); env.validation.ts đã bắt buộc DATABASE_URL đi kèm RABBITMQ_URL.
export const isMessagingEnabled = (): boolean => has('RABBITMQ_URL') && isDatabaseEnabled();
export const isStorageEnabled = (): boolean => has('S3_ENDPOINT');
// rental-service: cần DB (đơn, lịch xem), Redis (khóa theo tin, Idempotency-Key) và RabbitMQ (nghe
// payment.deposited). Ở môi trường thật rental.env.ts bắt buộc cả ba nên cờ này luôn bật; các test chung của
// template chạy thiếu một trong ba thì RentalModule không được nạp.
export const isRentalEnabled = (): boolean =>
  isDatabaseEnabled() && isRedisEnabled() && isMessagingEnabled();
