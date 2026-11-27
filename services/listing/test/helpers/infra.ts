import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { parseEnv } from 'node:util';

/** Schema Postgres riêng cho test hạ tầng (đặt qua search_path trong setup-infra-env.ts). */
export const INFRA_TEST_SCHEMA = 'template_infra_test';

/** Chờ đến khi `check()` trả giá trị truthy (thử lại mỗi 100ms), quá hạn thì ném lỗi. */
export async function waitFor<T>(
  check: () => Promise<T> | T,
  what: string,
  timeoutMs = 10000,
): Promise<NonNullable<T>> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await check();
    if (value) return value as NonNullable<T>;
    if (Date.now() > deadline) throw new Error(`Hết ${timeoutMs}ms vẫn chưa thấy: ${what}`);
    await sleep(100);
  }
}

/**
 * Đọc .env GỐC repo (chỉ đọc, không nạp vào process.env) để lấy mật khẩu hạ tầng dev.
 * Copy template sang services/<tên> thì đường dẫn vẫn đúng (cùng độ sâu).
 */
export function readRootEnv(): Record<string, string | undefined> {
  const path = resolve(__dirname, '..', '..', '..', '..', '.env');
  if (!existsSync(path)) {
    throw new Error(`Không thấy ${path}. Ở thư mục gốc repo chạy: Copy-Item .env.example .env`);
  }
  return parseEnv(readFileSync(path, 'utf8'));
}

/** Cấu hình S3 thật cho test hạ tầng, lấy từ .env gốc (R2, ADR-0016). */
export interface S3TestEnv {
  endpoint: string;
  region: string;
  accessKey: string;
  secretKey: string;
  /** Bucket CÓ SẴN dành cho test (R2: `infra-test`); test chỉ ghi và xóa key của chính nó. */
  bucket: string;
}

/**
 * Lấy cấu hình S3 cho test từ .env gốc. Thiếu một trong `S3_ENDPOINT`, `S3_ACCESS_KEY`,
 * `S3_SECRET_KEY`, `S3_TEST_BUCKET` → `null`: test S3 bỏ qua (không fail) khi máy chưa có khóa R2.
 */
export function s3TestEnv(root: Record<string, string | undefined>): S3TestEnv | null {
  const pick = (name: string): string | undefined => root[name]?.trim() || undefined;
  const endpoint = pick('S3_ENDPOINT');
  const accessKey = pick('S3_ACCESS_KEY');
  const secretKey = pick('S3_SECRET_KEY');
  const bucket = pick('S3_TEST_BUCKET');
  if (!endpoint || !accessKey || !secretKey || !bucket) return null;
  return { endpoint, region: pick('S3_REGION') ?? 'auto', accessKey, secretKey, bucket };
}
