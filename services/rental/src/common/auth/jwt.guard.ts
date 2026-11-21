import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { AppException } from '../errors/app.exception';
import { ErrorCode } from '../errors/error-codes';
import { AuthenticatedRequest } from './authenticated-user';
import { extractBearerToken, JwtTokenVerifier } from './jwt-token.verifier';
import { IS_PUBLIC_KEY } from './public.decorator';

/**
 * Guard toàn cục: mọi route phải có JWT hợp lệ trừ route gắn @Public().
 * Gateway đã verify token, nhưng service VẪN verify lại chữ ký (không tin mạng nội bộ).
 * Đọc header `Authorization: Bearer <token>`, kiểm tra claims { sub, roles[], exp }
 * (qua JwtTokenVerifier) và gắn `request.user` để dùng qua @CurrentUser().
 */
@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly verifier: JwtTokenVerifier,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) return true;

    // Không cấu hình JWT thì KHÔNG mở toang: 503 AUTH_NOT_CONFIGURED (kiểm trước khi xét token)
    this.verifier.assertConfigured();

    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const token = extractBearerToken(request.headers.authorization);
    if (!token) {
      throw new AppException(
        ErrorCode.AUTH_TOKEN_MISSING,
        'Thiếu header Authorization: Bearer <token>',
        401,
      );
    }

    request.user = await this.verifier.verify(token);
    return true;
  }
}
