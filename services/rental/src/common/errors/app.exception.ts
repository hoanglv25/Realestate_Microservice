import { HttpException } from '@nestjs/common';

/**
 * Exception chuẩn của dự án. Ném lỗi nghiệp vụ/hạ tầng bằng class này để response luôn đúng format:
 *   { code, message, details?, correlationId }
 *
 *   throw new AppException('DEPOSIT_ALREADY_PAID', 'Đơn đặt cọc đã được thanh toán', 409, { depositId });
 *
 * - `code`: mã máy đọc được (xem error-codes.ts), ổn định, client dựa vào đó để xử lý.
 * - `message`: thông điệp cho người đọc (tiếng Việt), KHÔNG chứa bí mật hay chi tiết nội bộ.
 * - `httpStatus`: 4xx cho lỗi nghiệp vụ, 503/504 cho lỗi hạ tầng.
 * - `details`: dữ liệu bổ sung tùy ý (mảng lỗi validate, id liên quan...).
 */
export class AppException extends HttpException {
  constructor(
    public readonly code: string,
    message: string,
    httpStatus = 400,
    public readonly details?: unknown,
  ) {
    super({ code, message, details }, httpStatus);
    // Giữ tên lớp để log dễ đọc
    this.name = 'AppException';
  }
}
