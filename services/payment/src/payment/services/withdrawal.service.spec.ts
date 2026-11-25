import { AppException } from '../../common/errors/app.exception';
import {
  CREATED,
  deps,
  fakeDb,
  FILE,
  IDS,
  uniqueViolation,
} from '../../../test/helpers/payout-kit';
import type { Route } from '../../../test/helpers/payout-kit';
import { WithdrawalService } from './withdrawal.service';

const ELIGIBLE = {
  depositId: IDS.deposit,
  ownerId: IDS.owner,
  amountVnd: 3_000_000,
  status: 'RELEASED',
  eligible: true,
  missing: [],
};
const BANK = {
  userId: IDS.owner,
  bankName: 'Vietcombank',
  accountHolder: 'TRAN THI BINH',
  accountNumber: '0123456789',
};
const SNAPSHOT = { bankName: 'Vietcombank', accountHolder: 'TRAN THI BINH', accountLast4: '6789' };
const FREE = { withdrawal_open: false, refund_open: false, refunded_vnd: '0' };

const wRow = (over: Record<string, unknown> = {}) => ({
  id: IDS.payout,
  deposit_id: IDS.deposit,
  owner_id: IDS.owner,
  amount_vnd: '3000000',
  bank_snapshot: SNAPSHOT,
  status: 'PENDING',
  reason: null,
  receipt_id: null,
  processed_by: null,
  processed_at: null,
  created_at: CREATED,
  ...over,
});

function setup(
  routes: Route[],
  opts: {
    eligibility?: unknown;
    bank?: unknown;
    rentalError?: unknown;
    identityError?: unknown;
  } = {},
) {
  const db = fakeDb(routes);
  const d = deps();
  const rental = {
    withdrawalEligibility: opts.rentalError
      ? jest.fn().mockRejectedValue(opts.rentalError)
      : jest.fn().mockResolvedValue(opts.eligibility ?? ELIGIBLE),
  };
  const identity = {
    getBankAccount: opts.identityError
      ? jest.fn().mockRejectedValue(opts.identityError)
      : jest.fn().mockResolvedValue(opts.bank === undefined ? BANK : opts.bank),
  };
  const svc = new WithdrawalService(
    db.dataSource as never,
    rental as never,
    identity as never,
    d.wallet as never,
    d.audit as never,
    d.outbox as never,
    d.receipts as never,
  );
  return { ...db, ...d, rental, identity, svc };
}

async function fails(p: Promise<unknown>): Promise<[string, number, unknown]> {
  const e = (await p.catch((x: unknown) => x)) as AppException;
  expect(e).toBeInstanceOf(AppException);
  return [e.code, e.getStatus(), e.details];
}

const createRoutes = (state: Record<string, unknown> = FREE): Route[] => [
  [/^SELECT EXISTS/, () => [state]],
  [/^INSERT INTO withdrawal_requests/, (p) => [wRow({ amount_vnd: String(p[2]) })]],
];

describe('WithdrawalService.create (route 2, §1.1, BR-15)', () => {
  it('đơn RELEASED đủ mốc: 201 PENDING, số tiền = tiền cọc, bản chụp ngân hàng che 4 số cuối, 1 payment.withdrawal-requested; 2 truy vấn + outbox', async () => {
    const { svc, calls, outbox, rental, identity } = setup(createRoutes());
    const w = await svc.create(IDS.owner, IDS.deposit);
    expect(w).toMatchObject({ status: 'PENDING', amountVnd: 3_000_000, bankSnapshot: SNAPSHOT });
    expect(rental.withdrawalEligibility).toHaveBeenCalledWith(IDS.deposit);
    expect(identity.getBankAccount).toHaveBeenCalledWith(IDS.owner);
    expect(calls).toHaveLength(2);
    expect(calls[1].params).toEqual([IDS.deposit, IDS.owner, 3_000_000, JSON.stringify(SNAPSHOT)]);
    expect(JSON.stringify(calls)).not.toContain('0123456789'); // số đầy đủ không vào DB
    expect(outbox.add).toHaveBeenCalledWith(expect.anything(), 'payment.withdrawal-requested', {
      withdrawalId: IDS.payout,
      depositId: IDS.deposit,
      ownerId: IDS.owner,
      amountVnd: 3_000_000,
    });
  });

  it('test 6a: đơn REFUNDED (đã hoàn 70% cho người thuê) → số rút = cọc − tổng hoàn TENANT COMPLETED', async () => {
    const { svc, calls } = setup(createRoutes({ ...FREE, refunded_vnd: '2100000' }), {
      eligibility: { ...ELIGIBLE, status: 'REFUNDED' },
    });
    await expect(svc.create(IDS.owner, IDS.deposit)).resolves.toMatchObject({ amountVnd: 900_000 });
    expect(calls[0].sql).toContain("requester_type = 'TENANT' AND status = 'COMPLETED'");
  });

  it('số rút ≤ 0 → 409 PAYMENT_WITHDRAWAL_NOT_ELIGIBLE (missing rỗng), không gọi identity', async () => {
    const { svc, identity } = setup(createRoutes({ ...FREE, refunded_vnd: '3000000' }));
    expect(await fails(svc.create(IDS.owner, IDS.deposit))).toEqual([
      'PAYMENT_WITHDRAWAL_NOT_ELIGIBLE',
      409,
      { missing: [] },
    ]);
    expect(identity.getBankAccount).not.toHaveBeenCalled();
  });

  it('test 6: chưa đủ điều kiện → 409 kèm details.missing (Báo cáo T13), không đọc DB', async () => {
    const { svc, calls } = setup(createRoutes(), {
      eligibility: { ...ELIGIBLE, status: 'PAID', eligible: false, missing: ['NOT_RELEASED'] },
    });
    expect(await fails(svc.create(IDS.owner, IDS.deposit))).toEqual([
      'PAYMENT_WITHDRAWAL_NOT_ELIGIBLE',
      409,
      { missing: ['NOT_RELEASED'] },
    ]);
    expect(calls).toHaveLength(0);
  });

  it('không phải chủ trọ của đơn → 403 FORBIDDEN', async () => {
    const { svc } = setup(createRoutes(), {
      eligibility: { ...ELIGIBLE, ownerId: IDS.tenant },
    });
    expect((await fails(svc.create(IDS.owner, IDS.deposit))).slice(0, 2)).toEqual([
      'FORBIDDEN',
      403,
    ]);
  });

  it.each([
    ['lệnh rút PENDING/COMPLETED', { ...FREE, withdrawal_open: true }],
    ['yêu cầu hoàn PENDING_ADMIN/FAILED', { ...FREE, refund_open: true }],
  ])('test 7: đã có %s → 409 PAYMENT_PAYOUT_ALREADY_OPEN', async (_n, state) => {
    const { svc, identity } = setup(createRoutes(state));
    expect((await fails(svc.create(IDS.owner, IDS.deposit))).slice(0, 2)).toEqual([
      'PAYMENT_PAYOUT_ALREADY_OPEN',
      409,
    ]);
    expect(identity.getBankAccount).not.toHaveBeenCalled();
  });

  it('test 8: chưa khai ngân hàng → 409 PAYMENT_BANK_ACCOUNT_MISSING, không ghi gì', async () => {
    const { svc, calls, outbox } = setup(createRoutes(), { bank: null });
    expect((await fails(svc.create(IDS.owner, IDS.deposit))).slice(0, 2)).toEqual([
      'PAYMENT_BANK_ACCOUNT_MISSING',
      409,
    ]);
    expect(calls.some((c) => c.sql.startsWith('INSERT'))).toBe(false);
    expect(outbox.add).not.toHaveBeenCalled();
  });

  it('rental 404 / identity 503 chuyển nguyên, không ghi gì', async () => {
    const notFound = new AppException('RENTAL_DEPOSIT_NOT_FOUND', 'x', 404);
    const a = setup(createRoutes(), { rentalError: notFound });
    await expect(a.svc.create(IDS.owner, IDS.deposit)).rejects.toBe(notFound);
    const down = new AppException('UPSTREAM_UNAVAILABLE', 'x', 503);
    const b = setup(createRoutes(), { identityError: down });
    await expect(b.svc.create(IDS.owner, IDS.deposit)).rejects.toBe(down);
    expect(b.calls.some((c) => c.sql.startsWith('INSERT'))).toBe(false);
  });

  it('hai lệnh cùng lúc lọt qua kiểm tra: ux_withdrawal_active → 409 PAYMENT_PAYOUT_ALREADY_OPEN', async () => {
    const { svc } = setup([
      [/^SELECT EXISTS/, () => [FREE]],
      [
        /^INSERT INTO withdrawal_requests/,
        () => {
          throw uniqueViolation('ux_withdrawal_active');
        },
      ],
    ]);
    expect((await fails(svc.create(IDS.owner, IDS.deposit))).slice(0, 2)).toEqual([
      'PAYMENT_PAYOUT_ALREADY_OPEN',
      409,
    ]);
  });
});

describe('WithdrawalService.complete (route 6, §1.2)', () => {
  const okRoutes = (): Route[] => [
    [/^SELECT \* FROM withdrawal_requests WHERE id/, () => [wRow()]],
    [/^INSERT INTO transfer_receipts/, () => [{ id: IDS.receipt }]],
    [
      /^UPDATE withdrawal_requests SET status = 'COMPLETED'/,
      () => [
        [
          wRow({
            status: 'COMPLETED',
            receipt_id: IDS.receipt,
            processed_by: IDS.admin,
            processed_at: CREATED,
          }),
        ],
        1,
      ],
    ],
  ];

  it('chứng từ → COMPLETED, WITHDRAW_OUT, audit, 1 payment.withdrawal-completed', async () => {
    const { svc, calls, wallet, audit, outbox } = setup(okRoutes());
    await expect(svc.complete(IDS.admin, IDS.payout, FILE)).resolves.toMatchObject({
      status: 'COMPLETED',
      receiptId: IDS.receipt,
    });
    expect(calls[2].sql).toContain("WHERE id = $1 AND status = 'PENDING'");
    expect(wallet.debit).toHaveBeenCalledWith(expect.anything(), {
      type: 'WITHDRAW_OUT',
      amountVnd: 3_000_000,
      depositId: IDS.deposit,
      refType: 'WITHDRAWAL',
      refId: IDS.payout,
      tenantId: null,
      ownerId: IDS.owner,
    });
    expect(audit.log).toHaveBeenCalledWith(expect.anything(), {
      actorId: IDS.admin,
      action: 'COMPLETE_WITHDRAWAL',
      targetType: 'WITHDRAWAL',
      targetId: IDS.payout,
      before: { status: 'PENDING' },
      after: { status: 'COMPLETED', receiptId: IDS.receipt },
    });
    expect(outbox.add).toHaveBeenCalledWith(expect.anything(), 'payment.withdrawal-completed', {
      withdrawalId: IDS.payout,
      depositId: IDS.deposit,
      ownerId: IDS.owner,
      amountVnd: 3_000_000,
    });
  });

  it('không có → 404; không PENDING → 409; cả hai không lưu tệp', async () => {
    const a = setup([[/^SELECT \* FROM withdrawal_requests/, () => []]]);
    expect((await fails(a.svc.complete(IDS.admin, IDS.payout, FILE))).slice(0, 2)).toEqual([
      'PAYMENT_PAYOUT_NOT_FOUND',
      404,
    ]);
    const b = setup([[/^SELECT \* FROM withdrawal_requests/, () => [wRow({ status: 'FAILED' })]]]);
    expect((await fails(b.svc.complete(IDS.admin, IDS.payout, FILE))).slice(0, 2)).toEqual([
      'PAYMENT_PAYOUT_INVALID_STATUS',
      409,
    ]);
    expect(a.receipts.store).not.toHaveBeenCalled();
    expect(b.receipts.store).not.toHaveBeenCalled();
  });

  it('UPDATE 0 dòng (quản trị viên khác vừa xong) → 409, không trừ ví', async () => {
    const routes = okRoutes();
    routes[2] = [/^UPDATE withdrawal_requests/, () => [[], 0]];
    const { svc, wallet } = setup(routes);
    expect((await fails(svc.complete(IDS.admin, IDS.payout, FILE))).slice(0, 2)).toEqual([
      'PAYMENT_PAYOUT_INVALID_STATUS',
      409,
    ]);
    expect(wallet.debit).not.toHaveBeenCalled();
  });
});

describe('WithdrawalService.fail (route 7, §1.3)', () => {
  it('test 11: FAILED → ví không đổi, audit FAIL_WITHDRAWAL, 1 payment.withdrawal-failed {reason}', async () => {
    const { svc, wallet, audit, outbox, calls } = setup([
      [
        /^UPDATE withdrawal_requests SET status = 'FAILED'/,
        () => [[wRow({ status: 'FAILED', reason: 'Sai tên chủ tài khoản' })], 1],
      ],
    ]);
    await expect(svc.fail(IDS.admin, IDS.payout, 'Sai tên chủ tài khoản')).resolves.toMatchObject({
      status: 'FAILED',
    });
    expect(calls[0].sql).toContain("WHERE id = $1 AND status = 'PENDING'");
    expect(wallet.debit).not.toHaveBeenCalled();
    expect(audit.log).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: 'FAIL_WITHDRAWAL',
        before: { status: 'PENDING' },
        after: { status: 'FAILED', reason: 'Sai tên chủ tài khoản' },
      }),
    );
    expect(outbox.add).toHaveBeenCalledWith(expect.anything(), 'payment.withdrawal-failed', {
      withdrawalId: IDS.payout,
      depositId: IDS.deposit,
      ownerId: IDS.owner,
      amountVnd: 3_000_000,
      reason: 'Sai tên chủ tài khoản',
    });
  });

  it('0 dòng: không có → 404, sai trạng thái → 409', async () => {
    const a = setup([
      [/^UPDATE withdrawal_requests/, () => [[], 0]],
      [/^SELECT status FROM withdrawal_requests/, () => []],
    ]);
    expect((await fails(a.svc.fail(IDS.admin, IDS.payout, 'x'))).slice(0, 2)).toEqual([
      'PAYMENT_PAYOUT_NOT_FOUND',
      404,
    ]);
    const b = setup([
      [/^UPDATE withdrawal_requests/, () => [[], 0]],
      [/^SELECT status FROM withdrawal_requests/, () => [{ status: 'COMPLETED' }]],
    ]);
    expect((await fails(b.svc.fail(IDS.admin, IDS.payout, 'x'))).slice(0, 2)).toEqual([
      'PAYMENT_PAYOUT_INVALID_STATUS',
      409,
    ]);
  });
});
