/** Claims tối thiểu service cần từ JWT (do identity-service phát hành, gateway đã verify trước). */
export interface AuthUser {
  /** ID người dùng (subject). */
  sub: string;
  /** Danh sách vai trò, ví dụ ['ADMIN']; rỗng nếu token không có. */
  roles: string[];
  /** Thời điểm hết hạn, giây kể từ epoch (UTC). */
  exp: number;
}

/** Request sau khi JwtAuthGuard gắn user. */
export interface AuthenticatedRequest {
  headers: Record<string, string | string[] | undefined>;
  user?: AuthUser;
}
