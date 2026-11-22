import { readFileSync } from 'node:fs';
import { join } from 'node:path';

let cachedVersion: string | undefined;

/**
 * Phiên bản service hiển thị ở /health: ưu tiên env SERVICE_VERSION (CI/Docker truyền vào),
 * không có thì đọc `version` trong package.json (cwd là thư mục service, cũng đúng trong Docker).
 */
export function getServiceVersion(): string {
  if (cachedVersion) return cachedVersion;
  const fromEnv = process.env.SERVICE_VERSION?.trim();
  if (fromEnv) return (cachedVersion = fromEnv);
  try {
    const pkg = JSON.parse(readFileSync(join(process.cwd(), 'package.json'), 'utf8')) as {
      version?: string;
    };
    cachedVersion = pkg.version ?? '0.0.0';
  } catch {
    cachedVersion = '0.0.0';
  }
  return cachedVersion;
}
