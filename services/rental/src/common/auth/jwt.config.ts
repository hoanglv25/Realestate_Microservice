import { JwtVerifyOptions } from '@nestjs/jwt';
import { readFileSync } from 'node:fs';

/** Cách xác thực chữ ký token của service này. */
export interface JwtVerifyConfig {
  /** Khóa công khai (RS256) hoặc bí mật dùng chung (HS256). */
  key: string;
  algorithms: NonNullable<JwtVerifyOptions['algorithms']>;
  kind: 'public-key' | 'secret';
  issuer?: string;
}

export const JWT_VERIFY_CONFIG = Symbol('JWT_VERIFY_CONFIG');

interface JwtEnv {
  JWT_PUBLIC_KEY?: string;
  JWT_PUBLIC_KEY_PATH?: string;
  JWT_SECRET?: string;
  JWT_ISSUER?: string;
}

/**
 * Chọn nguồn khóa theo thứ tự ưu tiên:
 *   1. JWT_PUBLIC_KEY       (PEM, xuống dòng viết \n)  -> RS256
 *   2. JWT_PUBLIC_KEY_PATH  (đường dẫn file PEM)       -> RS256
 *   3. JWT_SECRET           (bí mật dùng chung, CHỈ dev) -> HS256
 * Trả về null nếu không cấu hình gì (khi đó route không @Public() trả 503 AUTH_NOT_CONFIGURED).
 *
 * Luôn CHỐT thuật toán theo loại khóa để chặn tấn công đổi thuật toán
 * (ví dụ ký HS256 bằng chính khóa công khai, hoặc alg "none").
 */
export function resolveJwtVerifyConfig(env: JwtEnv): JwtVerifyConfig | null {
  const issuer = env.JWT_ISSUER || undefined;

  if (env.JWT_PUBLIC_KEY) {
    return {
      key: env.JWT_PUBLIC_KEY.replace(/\\n/g, '\n'),
      algorithms: ['RS256'],
      kind: 'public-key',
      issuer,
    };
  }
  if (env.JWT_PUBLIC_KEY_PATH) {
    let key: string;
    try {
      key = readFileSync(env.JWT_PUBLIC_KEY_PATH, 'utf8');
    } catch {
      // Dừng ngay khi khởi động, báo rõ đường dẫn sai
      throw new Error(`Không đọc được JWT_PUBLIC_KEY_PATH: ${env.JWT_PUBLIC_KEY_PATH}`);
    }
    return { key, algorithms: ['RS256'], kind: 'public-key', issuer };
  }
  if (env.JWT_SECRET) {
    return { key: env.JWT_SECRET, algorithms: ['HS256'], kind: 'secret', issuer };
  }
  return null;
}
