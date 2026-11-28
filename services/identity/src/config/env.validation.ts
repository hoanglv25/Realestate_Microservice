import Joi from 'joi';

/** Kiểu biến môi trường sau khi validate (đã áp mặc định). */
export interface EnvVars {
  NODE_ENV: 'development' | 'test' | 'production';
  PORT: number;
  SERVICE_NAME: string;
  SERVICE_VERSION?: string;
  LOG_LEVEL: 'fatal' | 'error' | 'warn' | 'info' | 'debug' | 'trace' | 'silent';
  LOG_PRETTY: boolean;
  HTTP_TIMEOUT_MS: number;
  HTTP_MAX_RETRIES: number;
  SWAGGER_ENABLED: boolean;
  IDEMPOTENCY_TTL_SECONDS: number;
  // Tùy chọn: có biến thì bật module tương ứng
  DATABASE_URL?: string;
  REDIS_URL?: string;
  RABBITMQ_URL?: string;
  // Messaging (chỉ dùng khi có RABBITMQ_URL)
  RABBITMQ_EXCHANGE: string;
  RABBITMQ_QUEUE?: string;
  RABBITMQ_PREFETCH: number;
  RABBITMQ_MAX_RETRIES: number;
  OUTBOX_POLL_INTERVAL_MS: number;
  OUTBOX_BATCH_SIZE: number;
  /** false = không chạy relay đẩy outbox lên RabbitMQ (test không muốn bắn event thật). */
  OUTBOX_RELAY_ENABLED: boolean;
  // Object storage S3 (chỉ dùng khi có S3_ENDPOINT)
  S3_ENDPOINT?: string;
  S3_PUBLIC_ENDPOINT?: string;
  S3_REGION: string;
  S3_ACCESS_KEY?: string;
  S3_SECRET_KEY?: string;
  S3_FORCE_PATH_STYLE: boolean;
  S3_BUCKETS: string[];
  S3_PRESIGN_TTL_SECONDS: number;
  JWT_PUBLIC_KEY?: string;
  JWT_PUBLIC_KEY_PATH?: string;
  JWT_SECRET?: string;
  JWT_ISSUER?: string;
  // identity-service: khóa RIÊNG để ký token (PEM hoặc đường dẫn file) và thời hạn token
  JWT_PRIVATE_KEY?: string;
  JWT_PRIVATE_KEY_PATH?: string;
  JWT_ACCESS_TTL_SECONDS: number;
  JWT_REFRESH_TTL_SECONDS: number;
  /** Tiền tố key Redis lưu refresh token (test đổi để không đụng dữ liệu thật). */
  REFRESH_TOKEN_REDIS_PREFIX: string;
  /** identity-service: khóa AES-256-GCM mã hóa số tài khoản nhận tiền, base64 của đúng 32 byte. */
  BANK_ACCOUNT_ENCRYPTION_KEY?: string;
  // identity-service: gửi email OTP, đặt lại mật khẩu (SMTP; dev dùng Gmail App Password, C27)
  SMTP_HOST?: string;
  SMTP_PORT: number;
  SMTP_USER?: string;
  SMTP_PASSWORD?: string;
  MAIL_FROM?: string;
  // OTP xác minh email (Báo cáo Bảng 2.6)
  OTP_TTL_SECONDS: number;
  OTP_MAX_ATTEMPTS: number;
  OTP_RESEND_COOLDOWN_SECONDS: number;
  // Đặt lại mật khẩu
  PASSWORD_RESET_TTL_SECONDS: number;
  PASSWORD_RESET_URL: string;
  /** `aud` của ID token Google. Trống: route đăng nhập Google trả 503, service vẫn chạy. */
  GOOGLE_CLIENT_ID?: string;
}

const optionalString = Joi.string().trim().empty('');

export const envSchema = Joi.object<EnvVars>({
  // --- Tối thiểu ---
  NODE_ENV: Joi.string().valid('development', 'test', 'production').default('development'),
  PORT: Joi.number().port().default(3000),
  SERVICE_NAME: Joi.string().trim().min(1).required(),
  SERVICE_VERSION: optionalString,
  LOG_LEVEL: Joi.string()
    .valid('fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent')
    .default('info'),
  LOG_PRETTY: Joi.boolean().default(false),

  // --- HTTP client / Swagger / Idempotency ---
  HTTP_TIMEOUT_MS: Joi.number().integer().min(100).default(3000),
  HTTP_MAX_RETRIES: Joi.number().integer().min(0).max(5).default(2),
  SWAGGER_ENABLED: Joi.boolean().default(true),
  IDEMPOTENCY_TTL_SECONDS: Joi.number().integer().min(1).default(86400),

  // --- Tùy chọn ---
  DATABASE_URL: optionalString.uri({ scheme: ['postgres', 'postgresql'] }),
  REDIS_URL: optionalString.uri({ scheme: ['redis', 'rediss'] }),
  RABBITMQ_URL: optionalString.uri({ scheme: ['amqp', 'amqps'] }),
  JWT_PUBLIC_KEY: optionalString,
  JWT_PUBLIC_KEY_PATH: optionalString,
  JWT_SECRET: optionalString.min(16),
  JWT_ISSUER: optionalString,
  JWT_PRIVATE_KEY: optionalString,
  JWT_PRIVATE_KEY_PATH: optionalString,
  // Access token 15 phút; refresh token 7 ngày
  JWT_ACCESS_TTL_SECONDS: Joi.number().integer().min(60).max(86400).default(900),
  JWT_REFRESH_TTL_SECONDS: Joi.number().integer().min(300).max(7776000).default(604800),
  REFRESH_TOKEN_REDIS_PREFIX: Joi.string().trim().min(1).default('identity:'),
  BANK_ACCOUNT_ENCRYPTION_KEY: optionalString,

  // --- identity: SMTP, OTP, đặt lại mật khẩu, Google (API_Spec RE.IDENTITY §5) ---
  SMTP_HOST: optionalString,
  SMTP_PORT: Joi.number().integer().min(1).max(65535).default(587),
  SMTP_USER: optionalString,
  SMTP_PASSWORD: optionalString,
  MAIL_FROM: optionalString,
  OTP_TTL_SECONDS: Joi.number().integer().min(30).max(3600).default(300),
  OTP_MAX_ATTEMPTS: Joi.number().integer().min(1).max(20).default(5),
  OTP_RESEND_COOLDOWN_SECONDS: Joi.number().integer().min(0).max(3600).default(60),
  PASSWORD_RESET_TTL_SECONDS: Joi.number().integer().min(60).max(86400).default(900),
  PASSWORD_RESET_URL: Joi.string()
    .trim()
    .uri({ scheme: ['http', 'https'] })
    .default('http://localhost:3000/reset-password'),
  GOOGLE_CLIENT_ID: optionalString,

  // --- Messaging (RabbitMQ + outbox/inbox), chỉ có tác dụng khi có RABBITMQ_URL ---
  RABBITMQ_EXCHANGE: Joi.string().trim().min(1).default('domain.events'),
  // Queue service này đọc (khai báo trong infra/rabbitmq/definitions.json). Trống = chỉ publish.
  RABBITMQ_QUEUE: optionalString,
  RABBITMQ_PREFETCH: Joi.number().integer().min(1).max(500).default(10),
  RABBITMQ_MAX_RETRIES: Joi.number().integer().min(0).max(10).default(3),
  OUTBOX_POLL_INTERVAL_MS: Joi.number().integer().min(100).default(1000),
  OUTBOX_BATCH_SIZE: Joi.number().integer().min(1).max(500).default(50),
  OUTBOX_RELAY_ENABLED: Joi.boolean().default(true),

  // --- Object storage S3 (Cloudflare R2, xem decisions/0016), chỉ có tác dụng khi có S3_ENDPOINT ---
  S3_ENDPOINT: optionalString.uri({ scheme: ['http', 'https'] }),
  // Host ký vào presigned URL khi khác host service gọi (R2: để trống, dùng S3_ENDPOINT)
  S3_PUBLIC_ENDPOINT: optionalString.uri({ scheme: ['http', 'https'] }),
  S3_REGION: Joi.string().trim().min(1).default('us-east-1'),
  S3_ACCESS_KEY: optionalString,
  S3_SECRET_KEY: optionalString,
  S3_FORCE_PATH_STYLE: Joi.boolean().default(true),
  // Bucket CÓ SẴN service dùng, cách nhau dấu phẩy (ví dụ: listing-images); bucket đầu cho health check
  S3_BUCKETS: Joi.string()
    .trim()
    .empty('')
    .default([])
    .custom((value: string, helpers) => {
      const names = value
        .split(',')
        .map((b) => b.trim())
        .filter(Boolean);
      const bad = names.find((b) => !/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(b));
      return bad
        ? helpers.message({ custom: `tên bucket '${bad}' không hợp lệ (chữ thường, số, . -)` })
        : names;
    }),
  S3_PRESIGN_TTL_SECONDS: Joi.number().integer().min(60).max(604800).default(900),
})
  // Outbox và inbox nằm trong DB của service, nên bật RabbitMQ thì bắt buộc có DB.
  .with('RABBITMQ_URL', 'DATABASE_URL')
  .with('S3_ENDPOINT', ['S3_ACCESS_KEY', 'S3_SECRET_KEY']);

/** Gom lỗi Joi thành thông báo tiếng Việt, liệt kê rõ từng biến sai/thiếu. */
export function formatEnvErrors(error: Joi.ValidationError): string {
  const lines = error.details.map((d) => {
    const name = d.path.join('.');
    if (d.type === 'any.required') return `  - ${name}: THIẾU (bắt buộc)`;
    if (d.type === 'object.with') {
      const peer = String(d.context?.peer ?? '');
      return `  - ${peer}: THIẾU (bắt buộc khi có ${String(d.context?.main ?? '')})`;
    }
    return `  - ${name}: ${d.message.replace(/"[^"]+" /, '')}`;
  });
  return `Cấu hình môi trường không hợp lệ:\n${lines.join('\n')}`;
}

/** Dùng cho ConfigModule: ném lỗi khi sai, trả về giá trị đã áp mặc định khi đúng. */
export function validateEnv(raw: Record<string, unknown>): EnvVars {
  const { error, value } = envSchema.validate(raw, { abortEarly: false, allowUnknown: true });
  if (error) {
    throw new Error(formatEnvErrors(error));
  }
  return value as EnvVars;
}
