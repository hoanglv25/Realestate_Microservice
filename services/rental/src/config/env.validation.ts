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
  /** false: event vẫn được ghi vào outbox nhưng relay không tự gửi (dùng khi test). */
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
  // rental-service: URL nội bộ (bắt buộc ở rental.env.ts)
  INTERNAL_LISTING_URL?: string;
  INTERNAL_PAYMENT_URL?: string;
  // rental-service: saga đặt cọc (RE.DEPOSIT_SAGA/API_Spec.md §5)
  /** Thời gian giữ chỗ (BR-07), cũng là hạn của link payOS. */
  HOLD_TTL_SECONDS: number;
  /** TTL khóa Redis theo tin trong lúc chạy saga. */
  DEPOSIT_LOCK_TTL_MS: number;
  LISTING_CALL_TIMEOUT_MS: number;
  /** `[cần đo]`: chốt sau E1, E2; tổng saga ≤ 8 giây (NFR07). */
  PAYMENT_CALL_TIMEOUT_MS: number;
  // Mốc khi đơn PAID (RE.DEPOSIT_LIFECYCLE §6)
  REFUND_WINDOW_SECONDS: number;
  AUTO_RELEASE_SECONDS: number;
  // SagaReconcileJob (RE.DEPOSIT_SAGA §5, §7; T3.3)
  /** Chu kỳ job đối soát (ms); `0` tắt job (test gọi `runOnce` trực tiếp). */
  SAGA_RECONCILE_INTERVAL_MS: number;
  /** Đơn `PENDING_PAYMENT` chưa có order quá số giây này thì job (a) hỏi lại payment. */
  SAGA_STUCK_AFTER_SECONDS: number;
  // HoldExpiryJob (RE.DEPOSIT_SAGA §5, §7; T3.4b)
  /** Chu kỳ job hết hạn giữ chỗ (ms, E4 cần ≤ 10 giây); `0` tắt job (test gọi `runOnce` trực tiếp). */
  HOLD_EXPIRY_INTERVAL_MS: number;
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

  // --- Messaging (RabbitMQ + outbox/inbox), chỉ có tác dụng khi có RABBITMQ_URL ---
  RABBITMQ_EXCHANGE: Joi.string().trim().min(1).default('domain.events'),
  // Queue service này đọc (khai báo trong infra/rabbitmq/definitions.json). Trống = chỉ publish.
  RABBITMQ_QUEUE: optionalString,
  RABBITMQ_PREFETCH: Joi.number().integer().min(1).max(500).default(10),
  RABBITMQ_MAX_RETRIES: Joi.number().integer().min(0).max(10).default(3),
  OUTBOX_POLL_INTERVAL_MS: Joi.number().integer().min(100).default(1000),
  OUTBOX_BATCH_SIZE: Joi.number().integer().min(1).max(500).default(50),
  OUTBOX_RELAY_ENABLED: Joi.boolean().default(true),

  // --- Object storage S3 (Silo ở dev, xem docs/adr/ADR-007), chỉ có tác dụng khi có S3_ENDPOINT ---
  S3_ENDPOINT: optionalString.uri({ scheme: ['http', 'https'] }),
  // Địa chỉ trình duyệt dùng để mở presigned URL (service trong Docker thấy s3:9000, trình duyệt thì không)
  S3_PUBLIC_ENDPOINT: optionalString.uri({ scheme: ['http', 'https'] }),
  S3_REGION: Joi.string().trim().min(1).default('us-east-1'),
  S3_ACCESS_KEY: optionalString,
  S3_SECRET_KEY: optionalString,
  S3_FORCE_PATH_STYLE: Joi.boolean().default(true),
  // Bucket service tự tạo lúc khởi động, cách nhau dấu phẩy (ví dụ: listing-images)
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

  // --- rental-service: saga đặt cọc (RE.DEPOSIT_SAGA §5), mốc sau khi PAID (RE.DEPOSIT_LIFECYCLE §6) ---
  INTERNAL_LISTING_URL: Joi.string()
    .trim()
    .uri({ scheme: ['http', 'https'] })
    .empty(''),
  INTERNAL_PAYMENT_URL: Joi.string()
    .trim()
    .uri({ scheme: ['http', 'https'] })
    .empty(''),
  HOLD_TTL_SECONDS: Joi.number().integer().min(30).max(86400).default(600),
  DEPOSIT_LOCK_TTL_MS: Joi.number().integer().min(1000).max(60000).default(10000),
  LISTING_CALL_TIMEOUT_MS: Joi.number().integer().min(100).max(30000).default(2000),
  PAYMENT_CALL_TIMEOUT_MS: Joi.number().integer().min(100).max(30000).default(3000),
  REFUND_WINDOW_SECONDS: Joi.number().integer().min(10).default(172800),
  AUTO_RELEASE_SECONDS: Joi.number().integer().min(10).default(259200),
  SAGA_RECONCILE_INTERVAL_MS: Joi.number().integer().min(0).max(3600000).default(15000),
  SAGA_STUCK_AFTER_SECONDS: Joi.number().integer().min(1).max(86400).default(30),
  HOLD_EXPIRY_INTERVAL_MS: Joi.number().integer().min(0).max(3600000).default(5000),
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
