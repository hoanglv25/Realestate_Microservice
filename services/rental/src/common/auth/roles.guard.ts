import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { AppException } from '../errors/app.exception';
import { ErrorCode } from '../errors/error-codes';
import { AuthenticatedRequest } from './authenticated-user';
import { ROLES_KEY } from './roles.decorator';

/**
 * Guard toàn cục chạy SAU JwtAuthGuard: nếu route gắn @Roles(...) thì người dùng phải có
 * ít nhất một vai trò đó, ngược lại 403 FORBIDDEN_ROLE. Route không gắn @Roles thì cho qua.
 */
@Injectable()
export class RolesGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const required = this.reflector.getAllAndOverride<string[] | undefined>(ROLES_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (!required?.length) return true;

    const user = context.switchToHttp().getRequest<AuthenticatedRequest>().user;
    if (!user) {
      // Gắn @Roles cùng @Public() là sai cấu hình: không có người dùng để kiểm tra vai trò
      throw new AppException(ErrorCode.UNAUTHORIZED, 'Cần đăng nhập để truy cập', 401);
    }
    if (!required.some((role) => user.roles.includes(role))) {
      throw new AppException(
        ErrorCode.FORBIDDEN_ROLE,
        'Bạn không có quyền thực hiện thao tác này',
        403,
        {
          requiredAnyOf: required,
        },
      );
    }
    return true;
  }
}
