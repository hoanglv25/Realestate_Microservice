import { ArgumentsHost, Catch, ExceptionFilter, HttpException } from '@nestjs/common';
import { HttpAdapterHost } from '@nestjs/core';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { PinoLogger } from 'nestjs-pino';
import { getCorrelationId, resolveCorrelationId } from '../logging/correlation-id.middleware';
import { AppException } from './app.exception';
import { buildMeta, ResponseMeta } from '../response/response-meta';
import { codeFromStatus, ErrorCode } from './error-codes';

/** Phần `error` của response lỗi. */
export interface ErrorBody {
  code: string;
  message: string;
  details?: unknown;
}

/** Format lỗi thống nhất cho MỌI response lỗi của mọi service: { error, meta }. */
export interface ErrorResponse {
  error: ErrorBody;
  meta: ResponseMeta;
}

interface MappedError {
  status: number;
  code: string;
  message: string;
  details?: unknown;
  /** true: ghi log lỗi đầy đủ (kèm stack) phía server. */
  logError: boolean;
}

const GENERIC_500 = 'Lỗi hệ thống, vui lòng thử lại sau';

// Lỗi kết nối/timeout từ DB, Redis, mạng -> 503/504 (lỗi hạ tầng, không phải lỗi client).
const UNAVAILABLE_CODES = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'ENOTFOUND',
  'EAI_AGAIN',
  'EPIPE',
  'EHOSTUNREACH',
]);
const TIMEOUT_CODES = new Set(['ETIMEDOUT', 'ESOCKETTIMEDOUT', 'ECONNABORTED']);
const TIMEOUT_NAMES = new Set(['ConnectionTimedOutError', 'TimeoutError']);
const UNAVAILABLE_NAMES = new Set(['MaxRetriesPerRequestError']);
const TIMEOUT_MESSAGE =
  /connection terminated due to connection timeout|timeout exceeded when trying to connect/i;

const asRecord = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : undefined;

/** Phân loại lỗi hạ tầng (xét cả `cause` và AggregateError.errors của pg/Node). */
function classifyInfraError(error: unknown): MappedError | undefined {
  const root = asRecord(error);
  if (!root) return undefined;
  const candidates: Array<Record<string, unknown>> = [root];
  const cause = asRecord(root.cause);
  if (cause) candidates.push(cause);
  if (Array.isArray(root.errors)) {
    for (const inner of root.errors) {
      const rec = asRecord(inner);
      if (rec) candidates.push(rec);
    }
  }
  for (const c of candidates) {
    const code = typeof c.code === 'string' ? c.code : '';
    const name = typeof c.name === 'string' ? c.name : '';
    const message = typeof c.message === 'string' ? c.message : '';
    if (TIMEOUT_CODES.has(code) || TIMEOUT_NAMES.has(name) || TIMEOUT_MESSAGE.test(message)) {
      return {
        status: 504,
        code: ErrorCode.DEPENDENCY_TIMEOUT,
        message: 'Hệ thống phụ thuộc phản hồi quá chậm, vui lòng thử lại sau',
        logError: true,
      };
    }
    if (UNAVAILABLE_CODES.has(code) || UNAVAILABLE_NAMES.has(name)) {
      return {
        status: 503,
        code: ErrorCode.DEPENDENCY_UNAVAILABLE,
        message: 'Hệ thống phụ thuộc tạm thời không khả dụng, vui lòng thử lại sau',
        logError: true,
      };
    }
  }
  return undefined;
}

/** Lỗi 4xx do thư viện HTTP (body-parser...) ném, mang `status`/`statusCode` nhưng không phải HttpException. */
function clientErrorStatus(error: unknown): number | undefined {
  const rec = asRecord(error);
  const status = rec?.status ?? rec?.statusCode;
  return typeof status === 'number' && status >= 400 && status < 500 ? status : undefined;
}

function mapException(exception: unknown): MappedError {
  if (exception instanceof AppException) {
    const status = exception.getStatus();
    return {
      status,
      code: exception.code,
      message: exception.message,
      details: exception.details,
      logError: status >= 500,
    };
  }

  if (exception instanceof HttpException) {
    const status = exception.getStatus();
    const body = exception.getResponse();
    const raw = asRecord(body)?.message;
    const message =
      typeof body === 'string' ? body : typeof raw === 'string' ? raw : exception.message;
    return {
      status,
      code: codeFromStatus(status),
      message,
      details: Array.isArray(raw) ? raw : undefined,
      logError: status >= 500,
    };
  }

  const infra = classifyInfraError(exception);
  if (infra) return infra;

  const clientStatus = clientErrorStatus(exception);
  if (clientStatus) {
    const message = exception instanceof Error ? exception.message : 'Yêu cầu không hợp lệ';
    return { status: clientStatus, code: codeFromStatus(clientStatus), message, logError: false };
  }

  // Lỗi không lường trước: KHÔNG lộ message/stack ra client, chỉ ghi log phía server.
  return { status: 500, code: ErrorCode.INTERNAL_ERROR, message: GENERIC_500, logError: true };
}

/**
 * Chuyển MỌI exception (AppException, HttpException, lỗi ValidationPipe, lỗi hạ tầng, lỗi không bắt)
 * về đúng một format: { error: { code, message, details? }, meta: { correlationId, timestamp } }.
 * Đăng ký qua APP_FILTER trong AppModule để áp dụng cả khi chạy test.
 */
@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  constructor(
    private readonly httpAdapterHost: HttpAdapterHost,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(AllExceptionsFilter.name);
  }

  catch(exception: unknown, host: ArgumentsHost): void {
    if (host.getType() !== 'http') return;

    const ctx = host.switchToHttp();
    const req = ctx.getRequest<IncomingMessage>();
    const res = ctx.getResponse<ServerResponse>();
    const mapped = mapException(exception);
    // Trong request luôn có ID từ middleware; resolve lại phòng trường hợp lỗi xảy ra rất sớm
    const correlationId = getCorrelationId() ?? resolveCorrelationId(req, res);

    if (mapped.logError) {
      this.logger.error({ err: exception, correlationId, code: mapped.code }, mapped.message);
    }

    const body: ErrorResponse = {
      error: {
        code: mapped.code,
        message: mapped.message,
        ...(mapped.details !== undefined && { details: mapped.details }),
      },
      meta: buildMeta(correlationId),
    };
    this.httpAdapterHost.httpAdapter.reply(res, body, mapped.status);
  }
}
