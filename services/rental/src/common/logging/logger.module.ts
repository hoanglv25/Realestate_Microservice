import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { LoggerModule } from 'nestjs-pino';
import { stdSerializers } from 'pino';
import type { DestinationStream } from 'pino';
import type { Options } from 'pino-http';
import { EnvVars } from '../../config/env.validation';
import { getCorrelationId } from './correlation-id.middleware';

/**
 * Token để test thay đích ghi log (mặc định null = ghi ra stdout).
 * Dùng: Test.createTestingModule(...).overrideProvider(LOG_STREAM).useValue({ write: (line) => ... })
 */
export const LOG_STREAM = Symbol('LOG_STREAM');

@Module({
  providers: [{ provide: LOG_STREAM, useValue: null }],
  exports: [LOG_STREAM],
})
class LogStreamModule {}

// Không bao giờ in các trường nhạy cảm, dù ai đó vô tình log cả request/body/headers.
// pino chỉ hỗ trợ ký tự đại diện MỘT cấp, nên liệt kê tường minh độ sâu 0 đến 3
// (password, a.password, a.b.password, a.b.b.password). Lồng sâu hơn thì KHÔNG được ẩn:
// đừng log nguyên object lớn, chỉ log các trường cần thiết.
const SENSITIVE_KEYS = [
  'authorization',
  'Authorization',
  'cookie',
  'Cookie',
  'password',
  'newPassword',
  'token',
  'accessToken',
  'refreshToken',
  'secret',
];
const REDACT_PATHS = [
  'res.headers["set-cookie"]',
  ...SENSITIVE_KEYS,
  ...SENSITIVE_KEYS.map((k) => `*.${k}`),
  ...SENSITIVE_KEYS.map((k) => `*.*.${k}`),
  ...SENSITIVE_KEYS.map((k) => `*.*.*.${k}`),
];

/**
 * Serializer cho `{ err }`: lỗi của axios mang theo `config` (có header Authorization/body),
 * `request` và `response` đầy đủ, nên log thẳng sẽ làm lộ bí mật. Chỉ giữ thông tin chẩn đoán.
 */
export function serializeError(err: unknown): Record<string, unknown> {
  const serialized = stdSerializers.err(err as Error) as unknown as Record<string, unknown>;
  delete serialized.config;
  delete serialized.request;
  const response = serialized.response as { status?: number; statusText?: string } | undefined;
  if (response) {
    serialized.response = { status: response.status, statusText: response.statusText };
  }
  return serialized;
}

/**
 * Log JSON một dòng ra stdout bằng nestjs-pino. Mỗi dòng có:
 *   level, time (ISO UTC), service, correlationId (khi nằm trong request), msg
 * Dòng tổng kết request (access-log.middleware.ts) thêm: method, url, statusCode, responseTime.
 * LOG_PRETTY=true bật pino-pretty (chỉ dùng dev).
 */
@Module({
  imports: [
    LoggerModule.forRootAsync({
      imports: [LogStreamModule],
      inject: [ConfigService, LOG_STREAM],
      useFactory: (config: ConfigService<EnvVars, true>, stream: DestinationStream | null) => {
        const pretty = config.get('LOG_PRETTY', { infer: true }) && !stream;
        const options: Options = {
          level: config.get('LOG_LEVEL', { infer: true }),
          base: { service: config.get('SERVICE_NAME', { infer: true }) },
          // Thời gian ISO-8601 UTC, ví dụ 2026-11-05T10:00:00.000Z
          timestamp: () => `,"time":"${new Date().toISOString()}"`,
          // level dạng chữ ("info") thay vì số (30)
          formatters: { level: (label) => ({ level: label }) },
          // Gắn correlationId vào MỌI dòng log phát sinh trong phạm vi request (log của service, filter...)
          mixin: () => {
            const correlationId = getCorrelationId();
            return correlationId ? { correlationId } : {};
          },
          redact: { paths: REDACT_PATHS, censor: '[REDACTED]' },
          serializers: { err: serializeError },
          ...(pretty && {
            transport: {
              target: 'pino-pretty',
              options: { singleLine: true, translateTime: 'SYS:standard' },
            },
          }),
        };
        return { pinoHttp: stream ? [options, stream] : options, forRoutes: [] };
      },
    }),
  ],
})
export class AppLoggerModule {}
