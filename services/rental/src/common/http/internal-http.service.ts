import { Injectable } from '@nestjs/common';
import { HttpService } from '@nestjs/axios';
import { ConfigService } from '@nestjs/config';
import { AxiosError, AxiosRequestConfig, isAxiosError } from 'axios';
import { PinoLogger } from 'nestjs-pino';
import { firstValueFrom } from 'rxjs';
import { EnvVars } from '../../config/env.validation';
import { AppException } from '../errors/app.exception';
import { codeFromStatus, ErrorCode } from '../errors/error-codes';
import { CORRELATION_HEADER, getCorrelationId } from '../logging/correlation-id.middleware';

export interface InternalRequestOptions {
  /** Header bổ sung. X-Request-ID luôn do wrapper gắn từ correlation ID hiện tại. */
  headers?: Record<string, string>;
  /** Query string. */
  params?: Record<string, string | number | boolean | undefined>;
  /** Ghi đè timeout (ms) cho riêng lần gọi này; mặc định HTTP_TIMEOUT_MS. */
  timeoutMs?: number;
  /**
   * Khai báo lệnh POST/PATCH này an toàn để thử lại (ví dụ đã gửi Idempotency-Key).
   * GET/HEAD/OPTIONS/PUT/DELETE vốn idempotent nên luôn được thử lại.
   */
  idempotent?: boolean;
}

type Method = 'GET' | 'HEAD' | 'OPTIONS' | 'PUT' | 'DELETE' | 'POST' | 'PATCH';

const IDEMPOTENT_METHODS = new Set<Method>(['GET', 'HEAD', 'OPTIONS', 'PUT', 'DELETE']);
const TIMEOUT_CODES = new Set(['ECONNABORTED', 'ETIMEDOUT', 'ESOCKETTIMEDOUT']);
/** Lỗi xảy ra trước khi request tới được đích: lệnh chắc chắn CHƯA được thực hiện. */
const NOT_SENT_CODES = new Set(['ECONNREFUSED', 'ENOTFOUND']);

/**
 * Kết quả lệnh gọi khi lỗi hạ tầng (C14, RE.SERVICE_TEMPLATE/API_Spec.md §3), để saga biết có cần đối soát:
 * NOT_EXECUTED = chắc chắn chưa chạy ở đích; UNKNOWN = có thể đã chạy.
 */
export type CallOutcome = 'NOT_EXECUTED' | 'UNKNOWN';
/** Upstream trả các mã này là lỗi tạm thời, đáng thử lại (nếu lệnh idempotent). */
const RETRYABLE_STATUS = new Set([502, 503, 504]);

const outcomeDetails = (outcome: CallOutcome): { outcome: CallOutcome } => ({ outcome });

const asRecord = (v: unknown): Record<string, unknown> | undefined =>
  typeof v === 'object' && v !== null ? (v as Record<string, unknown>) : undefined;

/**
 * Service đích trả { data, meta } (xem ResponseEnvelopeInterceptor): lấy `data` cho người gọi.
 * Body không đúng khung (ví dụ 204 hoặc service không dùng template) thì trả nguyên.
 */
function unwrapData<T>(body: unknown): T {
  const rec = asRecord(body);
  return (rec && 'data' in rec && 'meta' in rec ? rec.data : body) as T;
}

/**
 * HTTP client để gọi service khác (đường /internal/...). Bọc @nestjs/axios với:
 * - Timeout mặc định HTTP_TIMEOUT_MS (3000ms), ghi đè được theo từng lần gọi.
 * - Retry tối đa HTTP_MAX_RETRIES (2) lần, CHỈ cho GET/HEAD/OPTIONS/PUT/DELETE hoặc khi gọi
 *   với `{ idempotent: true }`; chỉ thử lại khi timeout, mất kết nối hoặc upstream trả 502/503/504.
 * - Tự gắn X-Request-ID = correlation ID hiện tại (lấy từ AsyncLocalStorage).
 * - Thành công: trả `data` bên trong khung { data, meta } của service đích.
 * - Chuẩn hóa lỗi thành AppException (không lộ địa chỉ nội bộ ra client):
 *     timeout -> 504 UPSTREAM_TIMEOUT          mất kết nối -> 503 UPSTREAM_UNAVAILABLE
 *     upstream 4xx -> GIỮ NGUYÊN mã, code, message, details của service đích
 *     upstream 504 -> 504; upstream 5xx khác -> 503 UPSTREAM_UNAVAILABLE
 * - Lỗi hạ tầng (503/504) kèm `details.outcome` (C14): NOT_EXECUTED chỉ khi MỌI lần thử đều lỗi
 *   trước khi gửi (ECONNREFUSED, ENOTFOUND); có lần nào timeout, mất kết nối giữa chừng hoặc đích
 *   trả 5xx thì UNKNOWN.
 *
 *   const room = await this.http.get<RoomDto>(`${listingUrl}/internal/rooms/${id}`);
 */
@Injectable()
export class InternalHttpService {
  constructor(
    private readonly http: HttpService,
    private readonly config: ConfigService<EnvVars, true>,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(InternalHttpService.name);
  }

  get<T = unknown>(url: string, options?: InternalRequestOptions): Promise<T> {
    return this.request<T>('GET', url, undefined, options);
  }

  post<T = unknown>(url: string, body?: unknown, options?: InternalRequestOptions): Promise<T> {
    return this.request<T>('POST', url, body, options);
  }

  put<T = unknown>(url: string, body?: unknown, options?: InternalRequestOptions): Promise<T> {
    return this.request<T>('PUT', url, body, options);
  }

  patch<T = unknown>(url: string, body?: unknown, options?: InternalRequestOptions): Promise<T> {
    return this.request<T>('PATCH', url, body, options);
  }

  delete<T = unknown>(url: string, options?: InternalRequestOptions): Promise<T> {
    return this.request<T>('DELETE', url, undefined, options);
  }

  async request<T = unknown>(
    method: Method,
    url: string,
    body?: unknown,
    options: InternalRequestOptions = {},
  ): Promise<T> {
    const maxRetries = this.config.getOrThrow('HTTP_MAX_RETRIES', { infer: true });
    const canRetry = IDEMPOTENT_METHODS.has(method) || options.idempotent === true;
    const correlationId = getCorrelationId();

    const axiosConfig: AxiosRequestConfig = {
      method,
      url,
      data: body,
      params: options.params,
      timeout: options.timeoutMs ?? this.config.getOrThrow('HTTP_TIMEOUT_MS', { infer: true }),
      maxRedirects: 0,
      headers: {
        ...options.headers,
        ...(correlationId && { [CORRELATION_HEADER]: correlationId }),
      },
    };

    // C14: lần thử nào KHÔNG chắc chắn là chưa tới đích (timeout, mất kết nối giữa chừng, đích trả
    // lỗi) thì lệnh có thể đã chạy, dù lần thử sau có refused. Chỉ NOT_EXECUTED khi MỌI lần thử
    // đều lỗi trước khi gửi.
    let maybeExecuted = false;
    for (let attempt = 0; ; attempt++) {
      try {
        const response = await firstValueFrom(this.http.request<T>(axiosConfig));
        return unwrapData<T>(response.data);
      } catch (error) {
        if (!isAxiosError(error)) throw error;
        if (!this.isNotSent(error)) maybeExecuted = true;
        if (canRetry && attempt < maxRetries && this.isRetryable(error)) {
          this.logger.warn(
            {
              attempt: attempt + 1,
              maxRetries,
              method,
              target: this.describe(url),
              reason: this.reason(error),
            },
            'Gọi service khác thất bại, thử lại',
          );
          await new Promise((resolve) => setTimeout(resolve, 100 * 2 ** attempt));
          continue;
        }
        throw this.toAppException(error, method, url, maybeExecuted);
      }
    }
  }

  /** Lỗi xảy ra trước khi request tới được đích (ECONNREFUSED, ENOTFOUND, không có response). */
  private isNotSent(error: AxiosError): boolean {
    return !error.response && error.code !== undefined && NOT_SENT_CODES.has(error.code);
  }

  private isRetryable(error: AxiosError): boolean {
    const status = error.response?.status;
    return status === undefined ? true : RETRYABLE_STATUS.has(status);
  }

  /** Chỉ host + path (bỏ query để không ghi tham số nhạy cảm vào log). */
  private describe(url: string): string {
    try {
      const u = new URL(url);
      return `${u.host}${u.pathname}`;
    } catch {
      return 'invalid-url';
    }
  }

  private reason(error: AxiosError): string {
    return error.response ? `HTTP ${error.response.status}` : (error.code ?? error.message);
  }

  private toAppException(
    error: AxiosError,
    method: Method,
    url: string,
    maybeExecuted: boolean,
  ): AppException {
    this.logger.warn(
      { method, target: this.describe(url), reason: this.reason(error) },
      'Gọi service khác thất bại',
    );

    const response = error.response;
    if (!response) {
      if (error.code && TIMEOUT_CODES.has(error.code)) {
        return new AppException(
          ErrorCode.UPSTREAM_TIMEOUT,
          'Service phụ thuộc phản hồi quá chậm, vui lòng thử lại sau',
          504,
          outcomeDetails('UNKNOWN'),
        );
      }
      return new AppException(
        ErrorCode.UPSTREAM_UNAVAILABLE,
        'Không kết nối được service phụ thuộc, vui lòng thử lại sau',
        503,
        outcomeDetails(!maybeExecuted && this.isNotSent(error) ? 'NOT_EXECUTED' : 'UNKNOWN'),
      );
    }

    const status = response.status;
    if (status >= 400 && status < 500) {
      // Giữ nguyên mã 4xx và nội dung lỗi của service đích (nếu đúng format dự án)
      // Lỗi nằm trong khung { error: { code, message, details }, meta }
      const error = asRecord(asRecord(response.data)?.error);
      const code = typeof error?.code === 'string' ? error.code : codeFromStatus(status);
      const message =
        typeof error?.message === 'string' ? error.message : 'Service phụ thuộc từ chối yêu cầu';
      return new AppException(code, message, status, error?.details);
    }

    // Đích đã nhận request rồi mới lỗi: không thể khẳng định lệnh chưa chạy
    if (status === 504) {
      return new AppException(
        ErrorCode.UPSTREAM_TIMEOUT,
        'Service phụ thuộc phản hồi quá chậm, vui lòng thử lại sau',
        504,
        outcomeDetails('UNKNOWN'),
      );
    }
    return new AppException(
      ErrorCode.UPSTREAM_UNAVAILABLE,
      'Service phụ thuộc đang gặp sự cố, vui lòng thử lại sau',
      503,
      outcomeDetails('UNKNOWN'),
    );
  }
}
