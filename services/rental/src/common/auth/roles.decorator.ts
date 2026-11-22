import { SetMetadata } from '@nestjs/common';

export const ROLES_KEY = 'auth:roles';

/**
 * Yêu cầu người dùng có ÍT NHẤT MỘT trong các vai trò liệt kê (so khớp chính xác, phân biệt hoa/thường).
 * Danh sách vai trò thật do identity-service quy định; template để kiểu chuỗi cho linh hoạt.
 *
 *   @Roles('ADMIN')
 *   @Roles('ADMIN', 'LANDLORD')
 */
export const Roles = (...roles: string[]): MethodDecorator & ClassDecorator =>
  SetMetadata(ROLES_KEY, roles);
