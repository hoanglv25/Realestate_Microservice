import type { Deposit, DepositStatus } from '../entities/deposit.entity';

/**
 * Máy trạng thái đơn đặt cọc — hàm thuần (`RE.DEPOSIT_LIFECYCLE/Component_Class_Design.md §1`), đúng bảng
 * `RE.BUSINESS_RULES.md §5`. Bàn giao (`admin_confirmed_at`) và chủ trọ xác nhận (`seller_acknowledged_at`) là mốc,
 * không phải trạng thái. Code đổi trạng thái vẫn là `UPDATE ... WHERE status = <từ>` (BR-18): bảng này chỉ quyết định
 * chuyển nào hợp lệ, không thay chống đua.
 */
export const DEPOSIT_ACTORS = ['TENANT', 'LANDLORD', 'ADMIN', 'SYSTEM', 'PAYOS'] as const;
export type DepositActor = (typeof DEPOSIT_ACTORS)[number];

/** `[từ, sang, tác nhân]`; `null` = chưa có đơn. */
const TRANSITIONS: ReadonlyArray<readonly [DepositStatus | null, DepositStatus, DepositActor]> = [
  [null, 'PENDING_PAYMENT', 'TENANT'], // đặt cọc, giữ chỗ được
  ['PENDING_PAYMENT', 'PAID', 'PAYOS'], // webhook hợp lệ trong 10 phút
  ['PENDING_PAYMENT', 'EXPIRED', 'SYSTEM'], // hết 10 phút, link đã hủy (BR-09)
  ['PENDING_PAYMENT', 'CANCELLED', 'SYSTEM'], // saga thất bại sau giữ chỗ (A1)
  ['PAID', 'RELEASED', 'TENANT'], // đã nhận phòng (BR-13)
  ['PAID', 'RELEASED', 'SYSTEM'], // đủ 3 ngày, không có yêu cầu hoàn đang xử lý (BR-13)
  ['PAID', 'REFUND_REQUESTED', 'TENANT'], // trong 48 giờ (BR-12)
  ['REFUND_REQUESTED', 'PAID', 'ADMIN'], // từ chối — đường lùi duy nhất
  ['REFUND_REQUESTED', 'REFUNDED', 'ADMIN'], // hoàn xong + chứng từ
  ['RELEASED', 'WITHDRAWN', 'ADMIN'], // chuyển tiền cho chủ trọ xong + chứng từ
];
const ALLOWED = new Set(TRANSITIONS.map(([f, t, a]) => `${f}>${t}>${a}`));

export function canTransition(
  from: DepositStatus | null,
  to: DepositStatus,
  actor: DepositActor,
): boolean {
  return ALLOWED.has(`${from}>${to}>${actor}`);
}

/** Nút người gọi được bấm trên đơn (chốt T3.5 B1, `API_Spec §1`). Rút tiền thuộc payment. */
export type DepositAction = 'CONFIRM_MOVE_IN' | 'REQUEST_REFUND' | 'ACKNOWLEDGE' | 'HAND_OVER';

export type DepositView = Pick<
  Deposit,
  | 'tenantId'
  | 'ownerId'
  | 'status'
  | 'refundDeadlineAt'
  | 'adminConfirmedAt'
  | 'sellerAcknowledgedAt'
>;
export interface Caller {
  sub: string;
  roles: string[];
}

export function allowedActions(d: DepositView, user: Caller, now: Date): DepositAction[] {
  const actions: DepositAction[] = [];
  if (user.roles.includes('TENANT') && d.tenantId === user.sub && d.status === 'PAID') {
    actions.push('CONFIRM_MOVE_IN');
    if (d.refundDeadlineAt && now.getTime() <= d.refundDeadlineAt.getTime()) {
      actions.push('REQUEST_REFUND');
    }
  }
  if (
    user.roles.includes('LANDLORD') &&
    d.ownerId === user.sub &&
    d.adminConfirmedAt &&
    !d.sellerAcknowledgedAt
  ) {
    actions.push('ACKNOWLEDGE');
  }
  if (
    user.roles.includes('ADMIN') &&
    (d.status === 'PAID' || d.status === 'RELEASED') &&
    !d.adminConfirmedAt
  ) {
    actions.push('HAND_OVER');
  }
  return actions;
}
