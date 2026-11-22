import { HttpException } from '@nestjs/common';
import type { SagaOutcome } from '../entities/saga-log.entity';

/**
 * Kết luận một lời gọi liên service bị lỗi (`RE.DEPOSIT_SAGA/Component_Class_Design.md §3`, chốt C14):
 *
 * - 4xx của service đích (InternalHttpService chuyển nguyên) → `BUSINESS_ERROR`: chắc chắn đích từ chối.
 * - 503/504 có `details.outcome = 'NOT_EXECUTED'` (mọi lần thử đều chưa gửi được) → `NOT_EXECUTED`.
 * - Mọi lỗi khác (timeout, 5xx, mất kết nối giữa chừng, lỗi lạ) → `UNKNOWN`: lệnh có thể đã chạy, cần đối soát.
 */
export function classifyCall(err: unknown): Exclude<SagaOutcome, 'OK'> {
  if (err instanceof HttpException) {
    const status = err.getStatus();
    if (status >= 400 && status < 500) return 'BUSINESS_ERROR';
    const response = err.getResponse() as { details?: { outcome?: unknown } } | string;
    if (typeof response === 'object' && response.details?.outcome === 'NOT_EXECUTED') {
      return 'NOT_EXECUTED';
    }
  }
  return 'UNKNOWN';
}
