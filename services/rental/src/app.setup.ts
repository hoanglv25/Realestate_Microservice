import { INestApplication, RequestMethod } from '@nestjs/common';
import type { Express } from 'express';
import { createAccessLogMiddleware } from './common/logging/access-log.middleware';
import { createCorrelationMiddleware } from './common/logging/correlation-id.middleware';

export const API_PREFIX = 'api/v1';

/**
 * Cấu hình dùng chung cho main.ts và test e2e (để test chạy đúng như thật):
 * - Middleware (gắn bằng app.use để phủ MỌI request, kể cả /health, /internal/*, 404):
 *   correlation ID (CLS) rồi access log.
 * - Prefix /api/v1 cho API công khai.
 * - /health giữ nguyên (cho Docker HEALTHCHECK) và có thêm /api/v1/health (alias).
 * - /internal/... KHÔNG gắn prefix: API nội bộ service-gọi-service, gateway không expose.
 */
export function configureApp(app: INestApplication): void {
  // Không công bố framework (header X-Powered-By: Express) cho kẻ dò quét
  (app.getHttpAdapter().getInstance() as Express).disable('x-powered-by');

  app.use(createCorrelationMiddleware());
  app.use(createAccessLogMiddleware());

  app.setGlobalPrefix(API_PREFIX, {
    exclude: [
      { path: 'health', method: RequestMethod.GET },
      { path: `${API_PREFIX}/health`, method: RequestMethod.GET },
      { path: 'internal/{*path}', method: RequestMethod.ALL },
    ],
  });
}
