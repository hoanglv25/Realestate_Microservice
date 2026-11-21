import { SetMetadata } from '@nestjs/common';

export const IS_PUBLIC_KEY = 'auth:isPublic';

/** Bỏ qua JwtAuthGuard cho route/controller này (ví dụ /health, đăng nhập, API công khai). */
export const Public = (): MethodDecorator & ClassDecorator => SetMetadata(IS_PUBLIC_KEY, true);
