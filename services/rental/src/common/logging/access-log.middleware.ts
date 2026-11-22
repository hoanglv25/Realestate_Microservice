import type { NextFunction, Request, Response } from 'express';
import { PinoLogger } from 'nestjs-pino';
import { resolveCorrelationId } from './correlation-id.middleware';

// Docker HEALTHCHECK gọi liên tục nên không log để đỡ nhiễu.
const SILENT_PATHS = new Set(['/health']);

/**
 * Log một dòng JSON cho mỗi request khi response kết thúc:
 *   method, url, statusCode, responseTime (ms), correlationId.
 * Tự viết thay vì pino-http vì middleware của module bị Nest gắn thêm global prefix
 * (bỏ sót /health, /internal/* và request 404). Gắn bằng `app.use` để phủ mọi request.
 */
export function createAccessLogMiddleware() {
  return (req: Request, res: Response, next: NextFunction): void => {
    const start = process.hrtime.bigint();
    res.on('finish', () => {
      if (SILENT_PATHS.has(req.path)) return;
      const url = req.originalUrl;
      const statusCode = res.statusCode;
      const responseTime = Math.round(Number(process.hrtime.bigint() - start) / 1e4) / 100;
      const level = statusCode >= 500 ? 'error' : statusCode >= 400 ? 'warn' : 'info';
      // Sự kiện 'finish' không nằm trong context CLS nên lấy ID đã gắn sẵn trên request
      PinoLogger.root[level](
        {
          correlationId: resolveCorrelationId(req),
          method: req.method,
          url,
          statusCode,
          responseTime,
        },
        `${req.method} ${url} ${statusCode}`,
      );
    });
    next();
  };
}
