export const IDEMPOTENT_KEY = 'idempotency:options';

export interface IdempotentOptions {
  /** Thời gian lưu kết quả (giây). Mặc định lấy từ env IDEMPOTENCY_TTL_SECONDS (24 giờ). */
  ttlSeconds?: number;
}
