import { randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { ClsMiddleware, ClsMiddlewareOptions, ClsServiceManager } from 'nestjs-cls';

/** Header mang correlation ID (gateway sinh; nếu thiếu thì service tự sinh UUID v4). */
export const CORRELATION_HEADER = 'X-Request-ID';

// Chỉ nhận ID "sạch" (chữ, số, . _ - :) tối đa 128 ký tự để tránh chèn ký tự lạ vào log.
const VALID_ID = /^[\w.:-]{1,128}$/;
const RESOLVED = Symbol.for('realestate.correlationId');

type TaggedRequest = IncomingMessage & { [RESOLVED]?: string };

/**
 * Xác định correlation ID của request và (nếu có `res`) gắn vào response header.
 * Idempotent: gọi nhiều lần cho cùng một request luôn trả cùng một ID.
 */
export function resolveCorrelationId(req: IncomingMessage, res?: ServerResponse): string {
  const tagged = req as TaggedRequest;
  if (!tagged[RESOLVED]) {
    const raw = req.headers['x-request-id'];
    const candidate = Array.isArray(raw) ? raw[0] : raw;
    tagged[RESOLVED] = candidate && VALID_ID.test(candidate) ? candidate : randomUUID();
  }
  const id = tagged[RESOLVED];
  if (res && !res.headersSent) {
    res.setHeader(CORRELATION_HEADER, id);
  }
  return id;
}

/**
 * Lấy correlation ID của request hiện tại ở BẤT KỲ đâu (service, guard, filter, HTTP client...)
 * nhờ AsyncLocalStorage (nestjs-cls). Ngoài phạm vi request (ví dụ lúc khởi động) trả về undefined.
 */
export function getCorrelationId(): string | undefined {
  const cls = ClsServiceManager.getClsService();
  return cls.isActive() ? cls.getId() : undefined;
}

const clsMiddlewareOptions: ClsMiddlewareOptions = {
  generateId: true,
  // Dùng chính correlation ID làm ID của context CLS
  idGenerator: (req: IncomingMessage) => resolveCorrelationId(req),
  setup: (_cls, req: IncomingMessage, res: ServerResponse) => {
    resolveCorrelationId(req, res);
  },
};

/**
 * Middleware mở context CLS + đặt correlation ID + gắn response header.
 *
 * PHẢI gắn bằng `app.use(...)` (xem app.setup.ts), KHÔNG dùng `ClsModule.forRoot({ middleware: { mount } })`:
 * middleware của module bị Nest gắn thêm global prefix nên chỉ chạy cho route dưới /api/v1/*,
 * bỏ sót /health, /internal/* và các request 404.
 */
export function createCorrelationMiddleware(): ClsMiddleware['use'] {
  return new ClsMiddleware(clsMiddlewareOptions).use;
}
