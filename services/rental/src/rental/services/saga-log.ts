import { HttpException } from '@nestjs/common';
import type { QueryDeepPartialEntity } from 'typeorm/query-builder/QueryPartialEntity';
import { getCorrelationId } from '../../common/logging/correlation-id.middleware';
import type { SagaLog, SagaOutcome, SagaStep } from '../entities/saga-log.entity';

/**
 * Chi tiết lỗi ghi vào `saga_log.detail`: mã lỗi và HTTP status, không dữ liệu cá nhân. `withDetails`: thêm
 * `details` của service đích (ví dụ `{ current, target }` của `409 LISTING_INVALID_STATUS`, C20).
 */
export function errorDetail(err: unknown, withDetails = false): Record<string, unknown> {
  if (err instanceof HttpException) {
    const res = err.getResponse() as { code?: unknown; details?: unknown } | string;
    const detail: Record<string, unknown> = {
      code: typeof res === 'object' ? res.code : undefined,
      status: err.getStatus(),
    };
    if (withDetails && typeof res === 'object' && res.details !== undefined)
      detail.details = res.details;
    return detail;
  }
  return { error: (err as { name?: string } | null)?.name ?? 'Error' };
}

/** Một dòng `saga_log` (chỉ ghi sau khi đã có `deposits`, khóa ngoại). */
export function sagaLogRow(
  depositId: string,
  step: SagaStep,
  outcome: SagaOutcome,
  detail: Record<string, unknown> | null = null,
): QueryDeepPartialEntity<SagaLog> {
  return {
    depositId,
    step,
    outcome,
    // jsonb: TypeORM không suy được kiểu sâu của Record<string, unknown>
    detail: detail as QueryDeepPartialEntity<SagaLog>['detail'],
    correlationId: getCorrelationId() ?? null,
  };
}
