import Joi from 'joi';

/**
 * Biến BẮT BUỘC riêng của rental-service (`RE.DEPOSIT_SAGA/API_Spec.md §5`), kiểm thêm ngoài envSchema chung.
 * Gọi từ env.bootstrap.ts khi khởi động (bỏ qua khi NODE_ENV=test để các test chung của template chạy được;
 * test của rental tự đặt đủ biến). Cùng cách với `listing.env.ts`, `payment.env.ts`.
 *
 * Rental cần DB (đơn, saga_log, lịch xem), Redis (khóa theo tin, Idempotency-Key), RabbitMQ (phát `rental.*`,
 * nghe `rental.payment-events`), URL nội bộ của listing và payment, khóa công khai JWT (route của người dùng).
 */
export const rentalRequiredSchema = Joi.object({
  DATABASE_URL: Joi.string().required(),
  REDIS_URL: Joi.string().required(),
  RABBITMQ_URL: Joi.string().required(),
  INTERNAL_LISTING_URL: Joi.string().required(),
  INTERNAL_PAYMENT_URL: Joi.string().required(),
  JWT_ISSUER: Joi.string().required(),
  JWT_PUBLIC_KEY: Joi.string(),
  JWT_PUBLIC_KEY_PATH: Joi.string(),
})
  .or('JWT_PUBLIC_KEY', 'JWT_PUBLIC_KEY_PATH')
  .unknown(true);

/** Trả về danh sách lỗi dễ đọc, rỗng nếu đủ. Không in giá trị biến (URL có thể chứa mật khẩu). */
export function checkRentalEnv(env: Record<string, unknown>): string[] {
  const clean = Object.fromEntries(
    Object.entries(env).filter(([, v]) => typeof v !== 'string' || v.trim() !== ''),
  );
  const { error } = rentalRequiredSchema.validate(clean, { abortEarly: false });
  if (!error) return [];
  return error.details.map((d) => {
    if (d.type === 'object.missing') {
      return `  - cần MỘT trong: ${(d.context?.peersWithLabels as string[] | undefined)?.join(' hoặc ') ?? d.message}`;
    }
    return `  - ${d.path.join('.')}: THIẾU (bắt buộc với rental-service)`;
  });
}
