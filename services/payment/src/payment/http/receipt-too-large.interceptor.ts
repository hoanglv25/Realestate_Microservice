import {
  CallHandler,
  ExecutionContext,
  Injectable,
  NestInterceptor,
  PayloadTooLargeException,
} from '@nestjs/common';
import { catchError, Observable, throwError } from 'rxjs';
import { receiptInvalid } from '../errors/payment.errors';

/**
 * Multer chặn tệp vượt `RECEIPT_MAX_BYTES` ngay lúc nhận (không đọc hết vào bộ nhớ) và Nest đổi lỗi đó thành
 * `413`. Thiết kế yêu cầu `400 PAYMENT_RECEIPT_INVALID` (`RE.PAYOUT/API_Spec.md §1.2` dòng 3), nên interceptor này
 * đặt NGOÀI `FileInterceptor` để đổi mã. Lỗi khác giữ nguyên.
 */
@Injectable()
export class ReceiptTooLargeInterceptor implements NestInterceptor {
  intercept(_context: ExecutionContext, next: CallHandler): Observable<unknown> {
    return next
      .handle()
      .pipe(
        catchError((err: unknown) =>
          throwError(() =>
            err instanceof PayloadTooLargeException ? receiptInvalid('TOO_LARGE') : err,
          ),
        ),
      );
  }
}
