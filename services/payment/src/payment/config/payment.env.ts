import Joi from 'joi';

/** Bucket chứng từ chuyển khoản (`RE.PAYOUT/API_Spec.md §6`, BR-17). */
export const PAYMENT_PROOFS_BUCKET = 'payment-proofs';

/**
 * Biến BẮT BUỘC riêng của payment-service (`RE.PAYMENT/API_Spec.md §5`), kiểm thêm ngoài envSchema chung.
 * Gọi từ env.bootstrap.ts khi khởi động (bỏ qua khi NODE_ENV=test để các test chung của template chạy được
 * không cần DB; test của payment tự đặt đủ biến). Cùng cách làm với `listing.env.ts`.
 *
 * T3.1 cần DB và payOS; T3.4a thêm RabbitMQ (phát sự kiện từ webhook). Khóa công khai JWT bắt buộc từ đầu vì payment có route cho người dùng
 * (rút tiền, lịch sử giao dịch, T3.6) và route quản trị; webhook payOS là `@Public` (T3.4).
 * T3.6 (`RE.PAYOUT §6`, B2): Redis cho `Idempotency-Key` (route 2, 6, 8), S3 cho chứng từ, URL nội bộ rental và identity.
 */
export const paymentRequiredSchema = Joi.object({
  DATABASE_URL: Joi.string().required(),
  // T3.4a: webhook phát payment.deposited, payment.late-payment-credited qua outbox (MessagingModule)
  RABBITMQ_URL: Joi.string().required(),
  PAYOS_CLIENT_ID: Joi.string().required(),
  PAYOS_API_KEY: Joi.string().required(),
  PAYOS_CHECKSUM_KEY: Joi.string().required(),
  JWT_ISSUER: Joi.string().required(),
  JWT_PUBLIC_KEY: Joi.string(),
  JWT_PUBLIC_KEY_PATH: Joi.string(),
  // T3.6: payout
  REDIS_URL: Joi.string().required(),
  S3_ENDPOINT: Joi.string().required(),
  S3_ACCESS_KEY: Joi.string().required(),
  S3_SECRET_KEY: Joi.string().required(),
  // Phải có `payment-proofs`: service tự tạo lúc khởi động và lưu chứng từ vào đó
  S3_BUCKETS: Joi.string()
    .required()
    .custom((value: string, helpers) =>
      value
        .split(',')
        .map((b) => b.trim())
        .includes(PAYMENT_PROOFS_BUCKET)
        ? value
        : helpers.error('any.invalid'),
    ),
  INTERNAL_RENTAL_URL: Joi.string().required(),
  INTERNAL_IDENTITY_URL: Joi.string().required(),
})
  .or('JWT_PUBLIC_KEY', 'JWT_PUBLIC_KEY_PATH')
  .unknown(true);

/** Trả về danh sách lỗi dễ đọc, rỗng nếu đủ. Không in giá trị biến (khóa payOS là bí mật). */
export function checkPaymentEnv(env: Record<string, unknown>): string[] {
  const clean = Object.fromEntries(
    Object.entries(env).filter(([, v]) => typeof v !== 'string' || v.trim() !== ''),
  );
  const { error } = paymentRequiredSchema.validate(clean, { abortEarly: false });
  if (!error) return [];
  return error.details.map((d) => {
    if (d.type === 'object.missing') {
      return `  - cần MỘT trong: ${(d.context?.peersWithLabels as string[] | undefined)?.join(' hoặc ') ?? d.message}`;
    }
    if (d.type === 'any.invalid') {
      return `  - ${d.path.join('.')}: phải có bucket '${PAYMENT_PROOFS_BUCKET}' (các bucket cách nhau dấu phẩy)`;
    }
    return `  - ${d.path.join('.')}: THIẾU (bắt buộc với payment-service)`;
  });
}
