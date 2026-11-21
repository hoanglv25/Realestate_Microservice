import { createHash } from 'node:crypto';

/** JSON "chuẩn hóa": khóa object được sắp xếp, nên cùng nội dung luôn ra cùng chuỗi dù thứ tự khóa khác. */
function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, v]) => [k, canonicalize(v)]),
    );
  }
  return value;
}

/** Vân tay (sha256) của body request, dùng để phát hiện "cùng Idempotency-Key nhưng body khác". */
export function fingerprintBody(body: unknown): string {
  return createHash('sha256')
    .update(JSON.stringify(canonicalize(body ?? null)))
    .digest('hex');
}
