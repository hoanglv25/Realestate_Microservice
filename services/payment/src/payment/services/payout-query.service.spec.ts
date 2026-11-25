import { plainToInstance } from 'class-transformer';
import { AppException } from '../../common/errors/app.exception';
import { CREATED, fakeDb, IDS } from '../../../test/helpers/payout-kit';
import type { Route } from '../../../test/helpers/payout-kit';
import { ListAuditLogsQuery, ListRefundsQuery, ListWithdrawalsQuery } from '../dto/payout.dto';
import { PageQueryDto } from '../../common/response/page-query.dto';
import { PayoutQueryService } from './payout-query.service';

const BANK = {
  userId: IDS.owner,
  bankName: 'Vietcombank',
  accountHolder: 'TRAN THI BINH',
  accountNumber: '0123456789',
};

function setup(routes: Route[], bank: unknown = BANK) {
  const db = fakeDb(routes);
  const identity = { getBankAccount: jest.fn().mockResolvedValue(bank) };
  return {
    ...db,
    identity,
    svc: new PayoutQueryService(db.dataSource as never, identity as never),
  };
}

const page = <T extends PageQueryDto>(cls: new () => T, q: Record<string, unknown> = {}): T =>
  plainToInstance(cls, q);

const wRow = {
  id: IDS.payout,
  deposit_id: IDS.deposit,
  owner_id: IDS.owner,
  amount_vnd: '900000',
  bank_snapshot: { bankName: 'Vietcombank', accountHolder: 'TRAN THI BINH', accountLast4: '6789' },
  status: 'PENDING',
  reason: null,
  receipt_id: null,
  processed_by: null,
  processed_at: null,
  created_at: CREATED,
};
const rRow = {
  id: IDS.payout,
  deposit_id: IDS.deposit,
  tenant_id: IDS.tenant,
  requester_type: 'SYSTEM',
  amount_vnd: '2000',
  status: 'PENDING_ADMIN',
  reason: null,
  receipt_id: null,
  processed_by: null,
  processed_at: null,
  created_at: CREATED,
};

describe('PayoutQueryService (RE.PAYOUT §1.4, §1.5)', () => {
  it('test 12: route 1 chỉ lấy giao dịch có tenant_id = sub HOẶC owner_id = sub (BR-19); 2 truy vấn; phân trang', async () => {
    const { svc, calls } = setup([
      [
        /^SELECT id, type, amount_vnd, deposit_id, created_at FROM wallet_transactions/,
        () => [
          {
            id: 'T1',
            type: 'DEPOSIT_IN',
            amount_vnd: '3000000',
            deposit_id: IDS.deposit,
            created_at: CREATED,
          },
        ],
      ],
      [/^SELECT count\(\*\) AS total FROM wallet_transactions/, () => [{ total: '41' }]],
    ]);
    const r = await svc.myTransactions(IDS.tenant, page(PageQueryDto, { page: 3, pageSize: 20 }));
    expect(r).toMatchObject({ page: 3, pageSize: 20, total: 41 });
    expect(r.items).toEqual([
      {
        id: 'T1',
        type: 'DEPOSIT_IN',
        amountVnd: 3_000_000,
        depositId: IDS.deposit,
        createdAt: CREATED.toISOString(),
      },
    ]);
    expect(calls).toHaveLength(2);
    expect(calls[0].sql).toContain('WHERE (tenant_id = $1 OR owner_id = $1)');
    expect(calls[0].sql).toContain('ORDER BY created_at DESC, id DESC LIMIT $2 OFFSET $3');
    expect(calls[0].params).toEqual([IDS.tenant, 20, 40]);
    expect(calls[1].params).toEqual([IDS.tenant]);
  });

  it('route 3: lệnh rút của chủ trọ; route 4: lọc status tùy chọn (không lọc → null)', async () => {
    const routes: Route[] = [
      [/^SELECT \* FROM withdrawal_requests/, () => [wRow]],
      [/^SELECT count\(\*\) AS total FROM withdrawal_requests/, () => [{ total: '1' }]],
    ];
    const a = setup(routes);
    const mine = await a.svc.myWithdrawals(IDS.owner, page(PageQueryDto));
    expect(mine.items[0]).toMatchObject({ id: IDS.payout, amountVnd: 900_000, status: 'PENDING' });
    expect(a.calls[0].sql).toContain('WHERE owner_id = $1');
    const b = setup(routes);
    await b.svc.adminWithdrawals(page(ListWithdrawalsQuery));
    expect(b.calls[0].sql).toContain('WHERE ($1::text IS NULL OR status = $1)');
    expect(b.calls[0].params[0]).toBeNull();
    const c = setup(routes);
    await c.svc.adminWithdrawals(page(ListWithdrawalsQuery, { status: 'PENDING' }));
    expect(c.calls[0].params[0]).toBe('PENDING');
    expect(c.identity.getBankAccount).not.toHaveBeenCalled(); // danh sách không gọi identity
  });

  it('route 5: yêu cầu hoàn, lọc status', async () => {
    const { svc, calls } = setup([
      [/^SELECT \* FROM refund_requests/, () => [rRow]],
      [/^SELECT count\(\*\) AS total FROM refund_requests/, () => [{ total: '1' }]],
    ]);
    const r = await svc.adminRefunds(page(ListRefundsQuery, { status: 'PENDING_ADMIN' }));
    expect(r.items[0]).toMatchObject({ requesterType: 'SYSTEM', amountVnd: 2000 });
    expect(calls[0].params[0]).toBe('PENDING_ADMIN');
  });

  it('route 11: một truy vấn; số dư, tổng rút PENDING, tổng hoàn PENDING_ADMIN/FAILED', async () => {
    const { svc, calls } = setup([
      [
        /^SELECT \(SELECT balance_vnd FROM admin_wallet/,
        () => [{ balance: '3002000', withdrawal: '900000', refund: '2000' }],
      ],
    ]);
    await expect(svc.wallet()).resolves.toEqual({
      balanceVnd: 3_002_000,
      pendingWithdrawalVnd: 900_000,
      pendingRefundVnd: 2000,
    });
    expect(calls).toHaveLength(1);
    expect(calls[0].sql).toContain("status IN ('PENDING_ADMIN','FAILED')");
  });

  it('route 12: nhật ký, lọc targetType, targetId tùy chọn', async () => {
    const { svc, calls } = setup([
      [
        /^SELECT \* FROM audit_log/,
        () => [
          {
            id: '9',
            actor_id: IDS.admin,
            action: 'COMPLETE_WITHDRAWAL',
            target_type: 'WITHDRAWAL',
            target_id: IDS.payout,
            before: { status: 'PENDING' },
            after: { status: 'COMPLETED' },
            correlation_id: 'c1',
            created_at: CREATED,
          },
        ],
      ],
      [/^SELECT count\(\*\) AS total FROM audit_log/, () => [{ total: '1' }]],
    ]);
    const r = await svc.auditLogs(page(ListAuditLogsQuery, { targetType: 'WITHDRAWAL' }));
    expect(r.items[0]).toMatchObject({ id: '9', actorId: IDS.admin, targetType: 'WITHDRAWAL' });
    expect(calls[0].params.slice(0, 2)).toEqual(['WITHDRAWAL', null]);
  });

  it('test 15: route 13 chi tiết lệnh rút kèm số tài khoản đầy đủ của chủ trọ (lấy lúc xem)', async () => {
    const { svc, identity } = setup([
      [/^SELECT \* FROM withdrawal_requests WHERE id/, () => [wRow]],
    ]);
    await expect(svc.withdrawalDetail(IDS.payout)).resolves.toMatchObject({
      id: IDS.payout,
      bankAccount: {
        bankName: 'Vietcombank',
        accountHolder: 'TRAN THI BINH',
        accountNumber: '0123456789',
      },
    });
    expect(identity.getBankAccount).toHaveBeenCalledWith(IDS.owner);
  });

  it('test 15: route 14 yêu cầu hoàn của người chưa khai (tiền đến muộn) → bankAccount null', async () => {
    const { svc, identity } = setup(
      [[/^SELECT \* FROM refund_requests WHERE id/, () => [rRow]]],
      null,
    );
    await expect(svc.refundDetail(IDS.payout)).resolves.toMatchObject({ bankAccount: null });
    expect(identity.getBankAccount).toHaveBeenCalledWith(IDS.tenant);
  });

  it('route 13, 14 không có → 404 PAYMENT_PAYOUT_NOT_FOUND, không gọi identity', async () => {
    const a = setup([[/^SELECT \* FROM withdrawal_requests/, () => []]]);
    const e = (await a.svc.withdrawalDetail(IDS.payout).catch((x: unknown) => x)) as AppException;
    expect([e.code, e.getStatus()]).toEqual(['PAYMENT_PAYOUT_NOT_FOUND', 404]);
    expect(a.identity.getBankAccount).not.toHaveBeenCalled();
    const b = setup([[/^SELECT \* FROM refund_requests/, () => []]]);
    await expect(b.svc.refundDetail(IDS.payout)).rejects.toBeInstanceOf(AppException);
  });
});
