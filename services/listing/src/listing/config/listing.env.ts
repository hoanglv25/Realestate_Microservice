import Joi from 'joi';

/** Bucket ảnh tin đăng (`RE.LISTING/API_Spec.md §5`). */
export const LISTING_IMAGES_BUCKET = 'listing-images';

/**
 * Biến BẮT BUỘC riêng của listing-service, kiểm tra thêm ngoài envSchema chung.
 * Gọi từ env.bootstrap.ts khi khởi động (bỏ qua khi NODE_ENV=test để các test chung của template
 * chạy được không cần DB/S3; test của listing tự đặt đủ biến).
 *
 * Tách riêng (không nhét vào envSchema) để envSchema vẫn dùng chung được cho mọi service,
 * giống `identity.env.ts`. Listing không cần Redis, RabbitMQ, khóa riêng JWT: chỉ kiểm token.
 */
export const listingRequiredSchema = Joi.object({
  DATABASE_URL: Joi.string().required(),
  S3_ENDPOINT: Joi.string().required(),
  S3_ACCESS_KEY: Joi.string().required(),
  S3_SECRET_KEY: Joi.string().required(),
  // Bucket phải có `listing-images` (tạo sẵn trên R2, service không tự tạo) và presign vào đó
  S3_BUCKETS: Joi.string()
    .required()
    .custom((value: string, helpers) =>
      value
        .split(',')
        .map((b) => b.trim())
        .includes(LISTING_IMAGES_BUCKET)
        ? value
        : helpers.error('any.invalid'),
    ),
  JWT_ISSUER: Joi.string().required(),
  JWT_PUBLIC_KEY: Joi.string(),
  JWT_PUBLIC_KEY_PATH: Joi.string(),
})
  .or('JWT_PUBLIC_KEY', 'JWT_PUBLIC_KEY_PATH')
  .unknown(true);

/** Trả về danh sách lỗi dễ đọc, rỗng nếu đủ. Không in giá trị biến (có thể là khóa thật). */
export function checkListingEnv(env: Record<string, unknown>): string[] {
  const clean = Object.fromEntries(
    Object.entries(env).filter(([, v]) => typeof v !== 'string' || v.trim() !== ''),
  );
  const { error } = listingRequiredSchema.validate(clean, { abortEarly: false });
  if (!error) return [];
  return error.details.map((d) => {
    if (d.type === 'object.missing') {
      return `  - cần MỘT trong: ${(d.context?.peersWithLabels as string[] | undefined)?.join(' hoặc ') ?? d.message}`;
    }
    if (d.type === 'any.invalid') {
      return `  - ${d.path.join('.')}: phải có bucket '${LISTING_IMAGES_BUCKET}' (các bucket cách nhau dấu phẩy)`;
    }
    return `  - ${d.path.join('.')}: THIẾU (bắt buộc với listing-service)`;
  });
}
