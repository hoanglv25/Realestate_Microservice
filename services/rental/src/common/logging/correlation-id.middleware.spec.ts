import type { IncomingMessage, ServerResponse } from 'node:http';
import { CORRELATION_HEADER, resolveCorrelationId } from './correlation-id.middleware';

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const req = (header?: string | string[]) =>
  ({
    headers: header === undefined ? {} : { 'x-request-id': header },
  }) as unknown as IncomingMessage;
const res = () => {
  const headers: Record<string, string> = {};
  return {
    headersSent: false,
    setHeader: (k: string, v: string) => void (headers[k] = v),
    headers,
  } as unknown as ServerResponse & { headers: Record<string, string> };
};

describe('resolveCorrelationId', () => {
  it('giữ nguyên X-Request-ID hợp lệ và gắn vào response header', () => {
    const r = res();
    expect(resolveCorrelationId(req('abc-123'), r)).toBe('abc-123');
    expect(r.headers[CORRELATION_HEADER]).toBe('abc-123');
  });

  it('thiếu header -> sinh UUID v4', () => {
    expect(resolveCorrelationId(req())).toMatch(UUID_V4);
  });

  it.each(['bad id;rm -rf', 'a'.repeat(129), '', 'có-dấu'])(
    'ID không hợp lệ %j -> thay bằng UUID',
    (bad) => {
      expect(resolveCorrelationId(req(bad))).toMatch(UUID_V4);
    },
  );

  it('lấy giá trị đầu tiên khi header lặp', () => {
    expect(resolveCorrelationId(req(['first-1', 'second-2']))).toBe('first-1');
  });

  it('idempotent: gọi nhiều lần cho cùng request luôn ra cùng ID', () => {
    const r = req();
    expect(resolveCorrelationId(r)).toBe(resolveCorrelationId(r));
  });
});
