import {
  CallHandler,
  ExecutionContext,
  Injectable,
  NestInterceptor,
  Optional,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Reflector } from '@nestjs/core';
import type { Request, Response } from 'express';
import { PinoLogger } from 'nestjs-pino';
import { catchError, from, mergeMap, Observable, of, throwError } from 'rxjs';
import { EnvVars } from '../../config/env.validation';
import { RedisService } from '../../redis/redis.service';
import { AuthenticatedRequest } from '../auth/authenticated-user';
import { AppException } from '../errors/app.exception';
import { ErrorCode } from '../errors/error-codes';
import { IDEMPOTENT_KEY, IdempotentOptions } from './idempotency.constants';
import { fingerprintBody } from './request-fingerprint';

const HEADER = 'idempotency-key';
const VALID_KEY = /^[\w.:-]{1,128}$/;
/** Khóa "đang xử lý" tự hết hạn sau 60 giây để request treo/crash không chặn client quá lâu. */
const LOCK_SECONDS = 60;

interface StoredRecord {
  state: 'processing' | 'done';
  hash: string;
  status?: number;
  body?: unknown;
}

/**
 * Cài đặt @Idempotent(): xem mô tả ở idempotent.decorator.ts.
 * Dùng Redis `SET NX` làm khóa nguyên tử nên hai request đồng thời cùng key không chạy handler hai lần.
 * RedisService được inject kiểu @Optional: thiếu Redis thì lỗi rõ ràng lúc gọi route, không vỡ DI.
 */
@Injectable()
export class IdempotencyInterceptor implements NestInterceptor {
  constructor(
    private readonly reflector: Reflector,
    private readonly config: ConfigService<EnvVars, true>,
    private readonly logger: PinoLogger,
    @Optional() private readonly redis?: RedisService,
  ) {
    this.logger.setContext(IdempotencyInterceptor.name);
  }

  async intercept(context: ExecutionContext, next: CallHandler): Promise<Observable<unknown>> {
    if (!this.redis) {
      throw new AppException(
        ErrorCode.IDEMPOTENCY_UNAVAILABLE,
        'Idempotency cần Redis: đặt REDIS_URL để bật',
        503,
      );
    }
    const redis = this.redis.client;
    const http = context.switchToHttp();
    const req = http.getRequest<Request & AuthenticatedRequest>();
    const res = http.getResponse<Response>();

    const rawKey = req.header(HEADER);
    if (!rawKey) {
      throw new AppException(
        ErrorCode.IDEMPOTENCY_KEY_REQUIRED,
        'Thiếu header Idempotency-Key cho thao tác này',
        400,
      );
    }
    if (!VALID_KEY.test(rawKey)) {
      throw new AppException(
        ErrorCode.BAD_REQUEST,
        'Idempotency-Key chỉ gồm chữ, số, . _ - : và tối đa 128 ký tự',
        400,
      );
    }

    const options =
      this.reflector.get<IdempotentOptions>(IDEMPOTENT_KEY, context.getHandler()) ?? {};
    const ttl: number =
      options.ttlSeconds ?? this.config.getOrThrow('IDEMPOTENCY_TTL_SECONDS', { infer: true });
    const service = this.config.getOrThrow('SERVICE_NAME', { infer: true });
    // Gắn theo service + route + người dùng để cùng key ở route/người khác không đụng nhau
    const route = (req.route as { path?: string } | undefined)?.path ?? req.path;
    const redisKey = `idem:${service}:${req.method}:${route}:${req.user?.sub ?? 'anon'}:${rawKey}`;
    const hash = fingerprintBody(req.body);

    // Tối đa 2 lần: khóa có thể vừa hết hạn giữa lúc SET NX thất bại và GET
    for (let attempt = 0; attempt < 2; attempt++) {
      const claimed = await redis.set(
        redisKey,
        JSON.stringify({ state: 'processing', hash } satisfies StoredRecord),
        'EX',
        LOCK_SECONDS,
        'NX',
      );
      if (claimed === 'OK') {
        return next.handle().pipe(
          mergeMap((body: unknown) =>
            from(this.saveResult(redisKey, hash, res.statusCode, body, ttl)),
          ),
          catchError((error: unknown) =>
            // Lỗi thì không lưu: xóa khóa để client thử lại cùng key
            from(redis.del(redisKey).catch(() => 0)).pipe(mergeMap(() => throwError(() => error))),
          ),
        );
      }

      const raw = await redis.get(redisKey);
      if (!raw) continue;
      const record = JSON.parse(raw) as StoredRecord;

      if (record.hash !== hash) {
        throw new AppException(
          ErrorCode.IDEMPOTENCY_KEY_REUSED,
          'Idempotency-Key này đã được dùng với nội dung request khác',
          422,
        );
      }
      if (record.state === 'processing') {
        throw new AppException(
          ErrorCode.IDEMPOTENCY_IN_PROGRESS,
          'Request với Idempotency-Key này đang được xử lý, thử lại sau giây lát',
          409,
        );
      }
      res.status(record.status ?? 200);
      res.setHeader('Idempotent-Replayed', 'true');
      return of(record.body ?? null);
    }

    throw new AppException(
      ErrorCode.IDEMPOTENCY_IN_PROGRESS,
      'Không khóa được Idempotency-Key, thử lại sau giây lát',
      409,
    );
  }

  /** Lưu response thành công. Lưu lỗi chỉ cảnh báo: thao tác nghiệp vụ đã xong, không được báo lỗi oan. */
  private async saveResult(
    redisKey: string,
    hash: string,
    status: number,
    body: unknown,
    ttl: number,
  ): Promise<unknown> {
    const record: StoredRecord = { state: 'done', hash, status, body: body ?? null };
    const redis = this.redis!.client;
    try {
      await redis.set(redisKey, JSON.stringify(record), 'EX', ttl);
    } catch (err) {
      this.logger.warn({ err, redisKey }, 'Không lưu được kết quả idempotency');
      await redis.del(redisKey).catch(() => 0);
    }
    return body;
  }
}
