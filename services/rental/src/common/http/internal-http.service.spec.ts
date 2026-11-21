import { HttpService } from '@nestjs/axios';
import { ConfigService } from '@nestjs/config';
import { AxiosError } from 'axios';
import { PinoLogger } from 'nestjs-pino';
import { throwError } from 'rxjs';
import { EnvVars } from '../../config/env.validation';
import { AppException } from '../errors/app.exception';
import { InternalHttpService } from './internal-http.service';

/** Lỗi mạng (không có response), ví dụ ECONNREFUSED, ECONNABORTED. */
const networkError = (code: string): AxiosError => new AxiosError('lỗi mạng', code);

/** Đích đã trả response với status cho trước. */
const httpError = (status: number): AxiosError =>
  new AxiosError('lỗi http', 'ERR_BAD_RESPONSE', undefined, undefined, {
    status,
    statusText: '',
    data: {},
    headers: {},
    config: {} as never,
  });

interface CallOptions {
  maxRetries?: number;
  idempotent?: boolean;
}

/** Mỗi lần gọi http.request ném lần lượt từng lỗi trong `errors` (lỗi cuối lặp lại nếu còn lần thử). */
async function failure(errors: AxiosError[], options: CallOptions = {}): Promise<AppException> {
  let calls = 0;
  const http = {
    request: jest.fn(() => {
      const error = errors[Math.min(calls, errors.length - 1)];
      calls += 1;
      return throwError(() => error);
    }),
  } as unknown as HttpService;
  const values: Partial<EnvVars> = {
    HTTP_MAX_RETRIES: options.maxRetries ?? 0,
    HTTP_TIMEOUT_MS: 100,
  };
  const config = { getOrThrow: (key: keyof EnvVars) => values[key] } as unknown as ConfigService<
    EnvVars,
    true
  >;
  const logger = { setContext: jest.fn(), warn: jest.fn() } as unknown as PinoLogger;
  const service = new InternalHttpService(http, config, logger);

  try {
    await service.post('http://dich.noi-bo/x', {}, { idempotent: options.idempotent });
  } catch (e) {
    return e as AppException;
  }
  throw new Error('phải ném AppException');
}

describe('InternalHttpService — details.outcome (C14)', () => {
  it.each(['ECONNREFUSED', 'ENOTFOUND'])(
    '%s: chưa gửi được request -> NOT_EXECUTED',
    async (code) => {
      const e = await failure([networkError(code)]);
      expect(e.getStatus()).toBe(503);
      expect(e.code).toBe('UPSTREAM_UNAVAILABLE');
      expect(e.details).toEqual({ outcome: 'NOT_EXECUTED' });
    },
  );

  it.each(['ECONNRESET', 'EPIPE'])('%s: mất kết nối giữa chừng -> UNKNOWN', async (code) => {
    const e = await failure([networkError(code)]);
    expect(e.getStatus()).toBe(503);
    expect(e.details).toEqual({ outcome: 'UNKNOWN' });
  });

  it.each(['ECONNABORTED', 'ETIMEDOUT', 'ESOCKETTIMEDOUT'])(
    '%s: timeout -> 504 UNKNOWN',
    async (code) => {
      const e = await failure([networkError(code)]);
      expect(e.getStatus()).toBe(504);
      expect(e.code).toBe('UPSTREAM_TIMEOUT');
      expect(e.details).toEqual({ outcome: 'UNKNOWN' });
    },
  );

  it.each([500, 502, 503])('đích trả %i -> 503 UNKNOWN', async (status) => {
    const e = await failure([httpError(status)]);
    expect(e.getStatus()).toBe(503);
    expect(e.details).toEqual({ outcome: 'UNKNOWN' });
  });
});

// Outcome tính qua MỌI lần thử, không chỉ lần cuối: lần trước có thể đã chạy ở đích (xem C14)
describe('InternalHttpService — details.outcome qua nhiều lần thử', () => {
  const retry = { maxRetries: 2, idempotent: true };

  it('refused cả 3 lần -> NOT_EXECUTED (không lần nào tới được đích)', async () => {
    const e = await failure([networkError('ECONNREFUSED')], retry);
    expect(e.getStatus()).toBe(503);
    expect(e.details).toEqual({ outcome: 'NOT_EXECUTED' });
  });

  it('refused rồi ENOTFOUND -> NOT_EXECUTED (cả hai đều lỗi trước khi gửi)', async () => {
    const e = await failure(
      [networkError('ECONNREFUSED'), networkError('ENOTFOUND'), networkError('ENOTFOUND')],
      retry,
    );
    expect(e.details).toEqual({ outcome: 'NOT_EXECUTED' });
  });

  it('lần 1 timeout, lần 2 refused -> UNKNOWN (lần 1 có thể đã chạy)', async () => {
    const e = await failure([networkError('ECONNABORTED'), networkError('ECONNREFUSED')], {
      maxRetries: 1,
      idempotent: true,
    });
    expect(e.getStatus()).toBe(503);
    expect(e.code).toBe('UPSTREAM_UNAVAILABLE');
    expect(e.details).toEqual({ outcome: 'UNKNOWN' });
  });

  it('lần 1 mất kết nối giữa chừng (ECONNRESET), các lần sau refused -> UNKNOWN', async () => {
    const e = await failure([networkError('ECONNRESET'), networkError('ECONNREFUSED')], retry);
    expect(e.details).toEqual({ outcome: 'UNKNOWN' });
  });

  it('lần 1 đích trả 503, các lần sau refused -> UNKNOWN (đích đã nhận request)', async () => {
    const e = await failure([httpError(503), networkError('ECONNREFUSED')], retry);
    expect(e.getStatus()).toBe(503);
    expect(e.details).toEqual({ outcome: 'UNKNOWN' });
  });

  it('refused rồi timeout -> 504 UNKNOWN', async () => {
    const e = await failure([networkError('ECONNREFUSED'), networkError('ECONNABORTED')], retry);
    expect(e.getStatus()).toBe(504);
    expect(e.details).toEqual({ outcome: 'UNKNOWN' });
  });

  it('POST không idempotent chỉ gọi một lần: refused -> NOT_EXECUTED', async () => {
    const e = await failure([networkError('ECONNREFUSED')], { maxRetries: 2 });
    expect(e.details).toEqual({ outcome: 'NOT_EXECUTED' });
  });
});
