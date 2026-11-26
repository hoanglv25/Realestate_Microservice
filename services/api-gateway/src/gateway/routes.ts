import type { EnvVars } from '../config/env.validation';

/** Mức truy cập (RE.GATEWAY/API_Spec.md §2). Gateway chỉ kiểm thô, service kiểm lại vai trò và chủ sở hữu. */
export type Access = 'public' | 'user' | 'tenant' | 'landlord' | 'admin' | 'payos';

export type ServiceName = 'identity' | 'listing' | 'rental' | 'payment' | 'notification';

/** Biến môi trường chứa địa chỉ của từng service đích. */
export const SERVICE_ENV_URL = {
  identity: 'INTERNAL_IDENTITY_URL',
  listing: 'INTERNAL_LISTING_URL',
  rental: 'INTERNAL_RENTAL_URL',
  payment: 'INTERNAL_PAYMENT_URL',
  notification: 'INTERNAL_NOTIFICATION_URL',
} as const satisfies Record<ServiceName, keyof EnvVars>;

export interface RouteRule {
  /** Bỏ trống = mọi method. HEAD khớp như GET. */
  methods?: readonly string[];
  /**
   * Đường dẫn đầy đủ. `:tên` khớp đúng một đoạn; `/*` ở cuối khớp chính tiền tố và mọi đường dẫn
   * dưới nó theo ranh giới đoạn (API_Spec.md §3, "Cách khớp").
   */
  pattern: string;
  service: ServiceName;
  access: Access;
}

/**
 * Bảng định tuyến: DỮ LIỆU, không logic. Nguồn: RE.GATEWAY/API_Spec.md §3 (đường dẫn chốt 2026-11-12, A6).
 * Duyệt từ trên xuống, dòng đầu khớp thắng, nên dòng cụ thể đứng TRƯỚC dòng chung.
 *
 * Không nằm trong bảng (xử lý trước đó): `/internal/*` → 404 (InternalBlockMiddleware, dòng 17) và
 * `GET /health` (HealthController của chính gateway, dòng 18).
 */
export const ROUTES: readonly RouteRule[] = [
  // identity — dòng 1, 2, 3
  { methods: ['GET'], pattern: '/api/v1/auth/me', service: 'identity', access: 'user' },
  { pattern: '/api/v1/auth/*', service: 'identity', access: 'public' },
  { pattern: '/api/v1/users/me/*', service: 'identity', access: 'user' },
  { pattern: '/api/v1/admin/users/*', service: 'identity', access: 'admin' },

  // listing — dòng 4, 5, 6. `mine` (landlord) PHẢI đứng trước `:id` (public), xem API_Spec.md §3 v1.3
  { methods: ['GET'], pattern: '/api/v1/listings/mine', service: 'listing', access: 'landlord' },
  { methods: ['GET'], pattern: '/api/v1/listings', service: 'listing', access: 'public' },
  { methods: ['GET'], pattern: '/api/v1/listings/:id', service: 'listing', access: 'public' },
  { pattern: '/api/v1/listings/*', service: 'listing', access: 'landlord' },
  { pattern: '/api/v1/admin/listings/*', service: 'listing', access: 'admin' },
  // listing — dòng 6a (v1.4): danh mục địa giới `RE.LOCATION`, chỉ GET, công khai
  { methods: ['GET'], pattern: '/api/v1/cities', service: 'listing', access: 'public' },
  { methods: ['GET'], pattern: '/api/v1/districts', service: 'listing', access: 'public' },

  // rental — dòng 7, 8, 9
  { pattern: '/api/v1/viewings/*', service: 'rental', access: 'user' },
  { pattern: '/api/v1/deposits/*', service: 'rental', access: 'user' },
  { pattern: '/api/v1/admin/deposits/*', service: 'rental', access: 'admin' },

  // payment — dòng 10, 11, 12, 13. Webhook đứng trước `/payments/*`
  {
    methods: ['POST'],
    pattern: '/api/v1/payments/payos/webhook',
    service: 'payment',
    access: 'payos',
  },
  { pattern: '/api/v1/payments/*', service: 'payment', access: 'user' },
  { pattern: '/api/v1/withdrawals/*', service: 'payment', access: 'landlord' },
  { pattern: '/api/v1/admin/withdrawals/*', service: 'payment', access: 'admin' },
  { pattern: '/api/v1/admin/refund-requests/*', service: 'payment', access: 'admin' },
  { pattern: '/api/v1/admin/wallet', service: 'payment', access: 'admin' },
  { pattern: '/api/v1/admin/audit-logs', service: 'payment', access: 'admin' },

  // notification — dòng 14, 15, 16. `/ws`: gateway chỉ chuyển tiếp upgrade (không qua AccessGuard);
  // notification kiểm access token trong handshake (RE.CHAT/API_Spec.md §3)
  { pattern: '/api/v1/notifications/*', service: 'notification', access: 'user' },
  { pattern: '/api/v1/conversations/*', service: 'notification', access: 'user' },
  { pattern: '/ws/*', service: 'notification', access: 'user' },
];
