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
