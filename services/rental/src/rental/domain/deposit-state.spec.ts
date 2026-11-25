import { DEPOSIT_STATUSES } from '../entities/deposit.entity';
import type { DepositStatus } from '../entities/deposit.entity';
import { DEPOSIT_ACTORS, allowedActions, canTransition } from './deposit-state';
import type { DepositActor, DepositView } from './deposit-state';

/** Bảng chuyển `RE.BUSINESS_RULES.md §5` (nguồn duy nhất cho test 1). */
const TABLE: Array<[DepositStatus | null, DepositStatus, DepositActor]> = [
  [null, 'PENDING_PAYMENT', 'TENANT'],
  ['PENDING_PAYMENT', 'PAID', 'PAYOS'],
  ['PENDING_PAYMENT', 'EXPIRED', 'SYSTEM'],
  ['PENDING_PAYMENT', 'CANCELLED', 'SYSTEM'],
  ['PAID', 'RELEASED', 'TENANT'],
  ['PAID', 'RELEASED', 'SYSTEM'],
  ['PAID', 'REFUND_REQUESTED', 'TENANT'],
  ['REFUND_REQUESTED', 'PAID', 'ADMIN'],
  ['REFUND_REQUESTED', 'REFUNDED', 'ADMIN'],
  ['RELEASED', 'WITHDRAWN', 'ADMIN'],
];
const key = (from: DepositStatus | null, to: DepositStatus, actor: DepositActor) =>
  `${from ?? '(chưa có)'} -> ${to} (${actor})`;
const ALLOWED = new Set(TABLE.map(([f, t, a]) => key(f, t, a)));

describe('deposit-state (RE.DEPOSIT_LIFECYCLE test 1, RE.BUSINESS_RULES §5)', () => {
  const froms: Array<DepositStatus | null> = [null, ...DEPOSIT_STATUSES];
  const cases = froms.flatMap((from) =>
    DEPOSIT_STATUSES.flatMap((to) =>
      DEPOSIT_ACTORS.map((actor) => [key(from, to, actor), from, to, actor] as const),
    ),
  );

  it.each(cases)('%s', (k, from, to, actor) => {
    expect(canTransition(from, to, actor)).toBe(ALLOWED.has(k));
  });

  it('đủ 10 dòng của bảng, không dòng nào thừa', () => {
    expect(cases.filter(([, f, t, a]) => canTransition(f, t, a))).toHaveLength(TABLE.length);
  });

  it('trạng thái kết thúc (EXPIRED, CANCELLED, REFUNDED, WITHDRAWN) không đi tiếp (BR-16)', () => {
    for (const from of ['EXPIRED', 'CANCELLED', 'REFUNDED', 'WITHDRAWN'] as const) {
      for (const to of DEPOSIT_STATUSES) {
        for (const actor of DEPOSIT_ACTORS) expect(canTransition(from, to, actor)).toBe(false);
      }
    }
  });
});

describe('allowedActions (RE.DEPOSIT_LIFECYCLE API_Spec §1, chốt T3.5 B1)', () => {
  const NOW = new Date('2026-11-25T08:00:00.000Z');
  const TENANT = { sub: 'tenant-1', roles: ['TENANT'] };
  const OWNER = { sub: 'owner-1', roles: ['LANDLORD'] };
  const ADMIN = { sub: 'admin-1', roles: ['ADMIN'] };
  const base: DepositView = {
    tenantId: 'tenant-1',
    ownerId: 'owner-1',
    status: 'PAID',
    refundDeadlineAt: new Date(NOW.getTime() + 3600_000),
    adminConfirmedAt: null,
    sellerAcknowledgedAt: null,
  };
  const d = (over: Partial<DepositView>): DepositView => ({ ...base, ...over });

  it('người thuê chủ đơn, PAID còn hạn hoàn -> CONFIRM_MOVE_IN, REQUEST_REFUND', () => {
    expect(allowedActions(base, TENANT, NOW)).toEqual(['CONFIRM_MOVE_IN', 'REQUEST_REFUND']);
  });

  it('người thuê, PAID quá hạn hoàn -> chỉ CONFIRM_MOVE_IN (BR-12)', () => {
    expect(
      allowedActions(d({ refundDeadlineAt: new Date(NOW.getTime() - 1) }), TENANT, NOW),
    ).toEqual(['CONFIRM_MOVE_IN']);
  });

  it('người thuê, đúng mốc hạn hoàn -> vẫn được yêu cầu hoàn (now <= refund_deadline_at)', () => {
    expect(allowedActions(d({ refundDeadlineAt: NOW }), TENANT, NOW)).toContain('REQUEST_REFUND');
  });

  it.each(['PENDING_PAYMENT', 'REFUND_REQUESTED', 'RELEASED', 'REFUNDED', 'WITHDRAWN'] as const)(
    'người thuê, đơn %s -> không có nút',
    (status) => {
      expect(allowedActions(d({ status }), TENANT, NOW)).toEqual([]);
    },
  );

  it('người thuê KHÁC -> không có nút', () => {
    expect(allowedActions(base, { sub: 'tenant-2', roles: ['TENANT'] }, NOW)).toEqual([]);
  });

  it('chủ tin: chưa bàn giao -> không; đã bàn giao chưa xác nhận -> ACKNOWLEDGE; đã xác nhận -> không', () => {
    expect(allowedActions(base, OWNER, NOW)).toEqual([]);
    expect(allowedActions(d({ adminConfirmedAt: NOW }), OWNER, NOW)).toEqual(['ACKNOWLEDGE']);
    expect(
      allowedActions(d({ adminConfirmedAt: NOW, sellerAcknowledgedAt: NOW }), OWNER, NOW),
    ).toEqual([]);
  });

  it('chủ trọ KHÁC -> không có nút', () => {
    expect(
      allowedActions(d({ adminConfirmedAt: NOW }), { sub: 'owner-2', roles: ['LANDLORD'] }, NOW),
    ).toEqual([]);
  });

  it('admin: PAID hoặc RELEASED chưa bàn giao -> HAND_OVER; đã bàn giao hoặc trạng thái khác -> không', () => {
    expect(allowedActions(base, ADMIN, NOW)).toEqual(['HAND_OVER']);
    expect(allowedActions(d({ status: 'RELEASED' }), ADMIN, NOW)).toEqual(['HAND_OVER']);
    expect(allowedActions(d({ adminConfirmedAt: NOW }), ADMIN, NOW)).toEqual([]);
    for (const status of ['REFUND_REQUESTED', 'PENDING_PAYMENT', 'REFUNDED'] as const) {
      expect(allowedActions(d({ status }), ADMIN, NOW)).toEqual([]);
    }
  });
});
