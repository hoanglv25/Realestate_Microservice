import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import { AuthenticatedRequest, AuthUser } from './authenticated-user';

/**
 * Lấy claims của người dùng đã xác thực (do JwtAuthGuard gắn vào request).
 *
 *   me(@CurrentUser() user: AuthUser) { ... }
 *   me(@CurrentUser('sub') userId: string) { ... }
 *
 * Với route @Public() không có token thì giá trị là undefined.
 */
export const CurrentUser = createParamDecorator(
  (field: keyof AuthUser | undefined, ctx: ExecutionContext) => {
    const user = ctx.switchToHttp().getRequest<AuthenticatedRequest>().user;
    return field ? user?.[field] : user;
  },
);
