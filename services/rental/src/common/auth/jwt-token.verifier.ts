import { Inject, Injectable } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { AppException } from '../errors/app.exception';
import { ErrorCode } from '../errors/error-codes';
import { AuthUser } from './authenticated-user';
import { JWT_VERIFY_CONFIG, JwtVerifyConfig } from './jwt.config';

/** Lấy token từ header `Authorization: Bearer <token>`. Sai dạng hoặc thiếu thì trả undefined. */
export function extractBearerToken(header: string | string[] | undefined): string | undefined {
  const value = Array.isArray(header) ? header[0] : header;
  return value?.match(/^Bearer\s+(\S+)$/i)?.[1];
}

const isString = (value: unknown): value is string => typeof value === 'string';

/**
 * Kiểm access token: chữ ký (thuật toán chốt theo loại khóa), hạn, `iss` và claims { sub, roles, exp }.
 * Dùng chung cho JwtAuthGuard của mọi service và AccessGuard của api-gateway (không có bản kiểm thứ hai).
 */
@Injectable()
export class JwtTokenVerifier {
  constructor(
    private readonly jwt: JwtService,
    @Inject(JWT_VERIFY_CONFIG) private readonly config: JwtVerifyConfig | null,
  ) {}

  get isConfigured(): boolean {
    return this.config !== null;
  }

  /** Không cấu hình JWT thì KHÔNG mở toang: từ chối rõ ràng thay vì cho qua. */
  assertConfigured(): JwtVerifyConfig {
    if (!this.config) {
      throw new AppException(
        ErrorCode.AUTH_NOT_CONFIGURED,
        'Service chưa cấu hình xác thực JWT (JWT_PUBLIC_KEY, JWT_PUBLIC_KEY_PATH hoặc JWT_SECRET)',
        503,
      );
    }
    return this.config;
  }

  async verify(token: string): Promise<AuthUser> {
    const cfg = this.assertConfigured();
    let payload: Record<string, unknown>;
    try {
      payload = await this.jwt.verifyAsync<Record<string, unknown>>(token, {
        ...(cfg.kind === 'secret' ? { secret: cfg.key } : { publicKey: cfg.key }),
        algorithms: cfg.algorithms,
        ...(cfg.issuer && { issuer: cfg.issuer }),
      });
    } catch (error) {
      const expired = error instanceof Error && error.name === 'TokenExpiredError';
      throw new AppException(
        expired ? ErrorCode.AUTH_TOKEN_EXPIRED : ErrorCode.AUTH_TOKEN_INVALID,
        expired ? 'Token đã hết hạn' : 'Token không hợp lệ',
        401,
      );
    }

    const { sub, roles, exp } = payload;
    const rolesValid = roles === undefined || (Array.isArray(roles) && roles.every(isString));
    if (typeof sub !== 'string' || !sub || typeof exp !== 'number' || !rolesValid) {
      throw new AppException(
        ErrorCode.AUTH_TOKEN_INVALID,
        'Token thiếu hoặc sai claims bắt buộc (sub, roles, exp)',
        401,
      );
    }
    return { sub, roles: (roles as string[] | undefined) ?? [], exp };
  }
}
