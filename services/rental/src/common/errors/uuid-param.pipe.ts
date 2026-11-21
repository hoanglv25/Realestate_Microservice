import { ParseUUIDPipe } from '@nestjs/common';
import { AppException } from './app.exception';
import { ErrorCode } from './error-codes';

/**
 * Pipe kiểm tham số đường dẫn là UUID, lỗi trả `400 VALIDATION_FAILED`, message "<tên> phải là UUID",
 * `details: [{ field, errors }]` (cùng dạng với lỗi của `createValidationPipe`, khớp
 * `contracts/openapi/*-internal.v1.yaml`).
 *
 * Dùng cho MỌI tham số đường dẫn kiểu UUID, công khai và nội bộ (C19, 2026-11-19). Không dùng
 * `new ParseUUIDPipe()` trần (trả `BAD_REQUEST`); luật ESLint ở `eslint.config.mjs` gốc chặn.
 *
 *   @Get(':id')
 *   find(@Param('id', createUuidParamPipe('id')) id: string) {}
 */
export function createUuidParamPipe(field = 'id'): ParseUUIDPipe {
  const message = `${field} phải là UUID`;
  return new ParseUUIDPipe({
    exceptionFactory: () =>
      new AppException(ErrorCode.VALIDATION_FAILED, message, 400, [{ field, errors: [message] }]),
  });
}
