import { SetMetadata } from '@nestjs/common';

export const RAW_RESPONSE_KEY = 'response:raw';

/**
 * Không bọc response của route/controller này vào { data, meta }.
 * Dùng cho /health (Docker HEALTHCHECK và công cụ giám sát đọc body phẳng).
 * Route trả 204 không cần gắn: interceptor tự bỏ qua.
 */
export const RawResponse = (): MethodDecorator & ClassDecorator =>
  SetMetadata(RAW_RESPONSE_KEY, true);
