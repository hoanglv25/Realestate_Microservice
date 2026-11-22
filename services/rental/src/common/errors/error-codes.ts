/**
 * Mã lỗi DÙNG CHUNG cho mọi service (trường `code` trong response lỗi).
 * Mã nghiệp vụ riêng của từng service (ví dụ DEPOSIT_ALREADY_PAID) khai báo trong module của service đó.
 * Quy ước: IN_HOA_GẠCH_DƯỚI, không đổi tên sau khi client đã dùng.
 */
export const ErrorCode = {
  // 4xx - lỗi do client/nghiệp vụ
  BAD_REQUEST: 'BAD_REQUEST', // 400
  VALIDATION_FAILED: 'VALIDATION_FAILED', // 400: DTO sai định dạng
  UNAUTHORIZED: 'UNAUTHORIZED', // 401
  AUTH_TOKEN_MISSING: 'AUTH_TOKEN_MISSING', // 401
  AUTH_TOKEN_INVALID: 'AUTH_TOKEN_INVALID', // 401
  AUTH_TOKEN_EXPIRED: 'AUTH_TOKEN_EXPIRED', // 401
  FORBIDDEN: 'FORBIDDEN', // 403
  FORBIDDEN_ROLE: 'FORBIDDEN_ROLE', // 403: thiếu vai trò
  NOT_FOUND: 'NOT_FOUND', // 404
  METHOD_NOT_ALLOWED: 'METHOD_NOT_ALLOWED', // 405
  CONFLICT: 'CONFLICT', // 409
  PAYLOAD_TOO_LARGE: 'PAYLOAD_TOO_LARGE', // 413
  UNPROCESSABLE_ENTITY: 'UNPROCESSABLE_ENTITY', // 422
  TOO_MANY_REQUESTS: 'TOO_MANY_REQUESTS', // 429
  IDEMPOTENCY_KEY_REQUIRED: 'IDEMPOTENCY_KEY_REQUIRED', // 400
  IDEMPOTENCY_KEY_REUSED: 'IDEMPOTENCY_KEY_REUSED', // 422: cùng key nhưng body khác
  IDEMPOTENCY_IN_PROGRESS: 'IDEMPOTENCY_IN_PROGRESS', // 409: request cùng key đang xử lý

  // 5xx - lỗi hạ tầng / hệ thống
  INTERNAL_ERROR: 'INTERNAL_ERROR', // 500: lỗi không lường trước (không lộ chi tiết)
  SERVICE_UNAVAILABLE: 'SERVICE_UNAVAILABLE', // 503
  DEPENDENCY_UNAVAILABLE: 'DEPENDENCY_UNAVAILABLE', // 503: DB/Redis/RabbitMQ không kết nối được
  DEPENDENCY_TIMEOUT: 'DEPENDENCY_TIMEOUT', // 504
  UPSTREAM_UNAVAILABLE: 'UPSTREAM_UNAVAILABLE', // 503: service khác không kết nối được
  UPSTREAM_TIMEOUT: 'UPSTREAM_TIMEOUT', // 504: service khác quá hạn
  AUTH_NOT_CONFIGURED: 'AUTH_NOT_CONFIGURED', // 503: service chưa cấu hình JWT
  IDEMPOTENCY_UNAVAILABLE: 'IDEMPOTENCY_UNAVAILABLE', // 503: chưa bật Redis
} as const;

export type ErrorCode = (typeof ErrorCode)[keyof typeof ErrorCode];

/** Mã mặc định theo HTTP status khi exception không mang mã riêng. */
export function codeFromStatus(status: number): string {
  switch (status) {
    case 400:
      return ErrorCode.BAD_REQUEST;
    case 401:
      return ErrorCode.UNAUTHORIZED;
    case 403:
      return ErrorCode.FORBIDDEN;
    case 404:
      return ErrorCode.NOT_FOUND;
    case 405:
      return ErrorCode.METHOD_NOT_ALLOWED;
    case 409:
      return ErrorCode.CONFLICT;
    case 413:
      return ErrorCode.PAYLOAD_TOO_LARGE;
    case 422:
      return ErrorCode.UNPROCESSABLE_ENTITY;
    case 429:
      return ErrorCode.TOO_MANY_REQUESTS;
    case 503:
      return ErrorCode.SERVICE_UNAVAILABLE;
    case 504:
      return ErrorCode.DEPENDENCY_TIMEOUT;
    default:
      return status >= 500 ? ErrorCode.INTERNAL_ERROR : ErrorCode.BAD_REQUEST;
  }
}
