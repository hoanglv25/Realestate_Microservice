import { ValidationError, ValidationPipe } from '@nestjs/common';
import { AppException } from './app.exception';
import { ErrorCode } from './error-codes';

export interface FieldError {
  field: string;
  errors: string[];
}

/** Làm phẳng cây ValidationError (DTO lồng nhau) thành [{ field: 'address.city', errors: [...] }]. */
export function flattenValidationErrors(errors: ValidationError[], parent = ''): FieldError[] {
  return errors.flatMap((e) => {
    const field = parent ? `${parent}.${e.property}` : e.property;
    const own = e.constraints ? [{ field, errors: Object.values(e.constraints) }] : [];
    return [...own, ...flattenValidationErrors(e.children ?? [], field)];
  });
}

/**
 * ValidationPipe toàn cục:
 * - whitelist: bỏ trường không khai báo; forbidNonWhitelisted: có trường thừa thì báo lỗi.
 * - transform: tự ép kiểu theo DTO (ví dụ "10" -> 10).
 * Lỗi trả về dạng AppException VALIDATION_FAILED (400) kèm details theo từng trường.
 */
export function createValidationPipe(): ValidationPipe {
  return new ValidationPipe({
    whitelist: true,
    forbidNonWhitelisted: true,
    transform: true,
    exceptionFactory: (errors: ValidationError[]) =>
      new AppException(
        ErrorCode.VALIDATION_FAILED,
        'Dữ liệu không hợp lệ',
        400,
        flattenValidationErrors(errors),
      ),
  });
}
