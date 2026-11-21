import { applyDecorators, SetMetadata, UseInterceptors } from '@nestjs/common';
import { ApiHeader } from '@nestjs/swagger';
import { IDEMPOTENT_KEY, IdempotentOptions } from './idempotency.constants';
import { IdempotencyInterceptor } from './idempotency.interceptor';

/**
 * BẬT idempotency cho một route (tắt = không gắn decorator). Client gửi header `Idempotency-Key`:
 * - Cùng key + cùng body: trả lại đúng response cũ (header `Idempotent-Replayed: true`), handler không chạy lại.
 * - Cùng key + body khác: 422 IDEMPOTENCY_KEY_REUSED.
 * - Cùng key đang được xử lý: 409 IDEMPOTENCY_IN_PROGRESS.
 * - Thiếu key: 400 IDEMPOTENCY_KEY_REQUIRED. Chưa bật Redis: 503 IDEMPOTENCY_UNAVAILABLE.
 * Chỉ response THÀNH CÔNG được lưu; handler lỗi thì key được xóa để client thử lại.
 * Dùng cho thao tác ghi quan trọng, đặc biệt tiền (đặt cọc, rút tiền).
 */
export const Idempotent = (options: IdempotentOptions = {}): MethodDecorator =>
  applyDecorators(
    SetMetadata(IDEMPOTENT_KEY, options),
    UseInterceptors(IdempotencyInterceptor),
    ApiHeader({
      name: 'Idempotency-Key',
      required: true,
      description:
        'Khóa duy nhất cho mỗi thao tác (ví dụ UUID); gửi lại cùng khóa để thử lại an toàn',
    }),
  );
