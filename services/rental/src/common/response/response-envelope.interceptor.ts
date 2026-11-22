import {
  CallHandler,
  ExecutionContext,
  Injectable,
  NestInterceptor,
  StreamableFile,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Response } from 'express';
import { map, Observable } from 'rxjs';
import { getCorrelationId } from '../logging/correlation-id.middleware';
import { RAW_RESPONSE_KEY } from './raw-response.decorator';
import { buildMeta, Paginated, ResponseMeta, SuccessResponse } from './response-meta';

/** Khóa metadata mà @HttpCode() của Nest ghi vào handler. */
const HTTP_CODE_METADATA = '__httpCode__';

/**
 * Bọc kết quả của MỌI controller thành { data, meta } để mọi service trả cùng một khung.
 * Controller và service vẫn chỉ trả dữ liệu thuần, không biết gì về khung này.
 *
 * Không bọc khi:
 *  - route gắn @RawResponse() (ví dụ /health);
 *  - route khai báo @HttpCode(204) (không có body);
 *  - kết quả là file/stream (StreamableFile).
 * Lỗi KHÔNG đi qua đây mà do AllExceptionsFilter dựng ({ error, meta }).
 *
 * Đăng ký qua APP_INTERCEPTOR trong AppModule (áp dụng cả khi chạy test).
 */
@Injectable()
export class ResponseEnvelopeInterceptor implements NestInterceptor {
  constructor(private readonly reflector: Reflector) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    if (context.getType() !== 'http') return next.handle();

    const targets = [context.getHandler(), context.getClass()];
    if (this.reflector.getAllAndOverride<boolean>(RAW_RESPONSE_KEY, targets)) return next.handle();
    if (Reflect.getMetadata(HTTP_CODE_METADATA, context.getHandler()) === 204) {
      return next.handle();
    }

    const res = context.switchToHttp().getResponse<Response>();
    return next.handle().pipe(
      map((result: unknown): unknown => {
        if (result instanceof StreamableFile) return result;

        // Lấy từ CLS; dự phòng bằng header đã gắn bởi middleware
        const correlationId = getCorrelationId() ?? String(res.getHeader('X-Request-ID') ?? '');

        if (result instanceof Paginated) {
          const extra: Partial<ResponseMeta> = {
            page: result.page,
            pageSize: result.pageSize,
            total: result.total,
            totalPages: result.pageSize > 0 ? Math.ceil(result.total / result.pageSize) : 0,
          };
          return {
            data: result.items,
            meta: buildMeta(correlationId, extra),
          } satisfies SuccessResponse;
        }
        // void/undefined thành data: null để luôn có khóa `data`
        return { data: result ?? null, meta: buildMeta(correlationId) } satisfies SuccessResponse;
      }),
    );
  }
}
