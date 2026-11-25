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
import { RefundService } from './refund.service';

const PAID_ORDER = {
  tenant_id: IDS.tenant,
  owner_id: IDS.owner,
  amount_vnd: '3000000',
  status: 'PAID',
};

const refundRow = (over: Record<string, unknown> = {}) => ({
  id: IDS.payout,
  deposit_id: IDS.deposit,
  tenant_id: IDS.tenant,
  requester_type: 'TENANT',
  amount_vnd: '2100000',
  status: 'PENDING_ADMIN',
  reason: null,
  receipt_id: null,
  processed_by: null,
  processed_at: null,
  created_at: CREATED,
  ...over,
});

function setup(routes: Route[]) {
  const db = fakeDb(routes);
  const d = deps();
  const svc = new RefundService(
    db.dataSource as never,
    d.wallet as never,
    d.audit as never,
    d.outbox as never,
    d.receipts as never,
  );
  return { ...db, ...d, svc };
}

async function fails(p: Promise<unknown>): Promise<[string, number]> {
  const e = (await p.catch((x: unknown) => x)) as AppException;
  expect(e).toBeInstanceOf(AppException);
  return [e.code, e.getStatus()];
}

describe('RefundService.createForTenant (API nội bộ, RE.PAYOUT §2)', () => {
  it('chưa có yêu cầu: tạo TENANT 70% (floor) PENDING_ADMIN, tenantId lấy từ payment_orders → created; 3 truy vấn', async () => {
    const { svc, calls } = setup([
      [/FROM payment_orders WHERE deposit_id/, () => [PAID_ORDER]],
      [/^SELECT \* FROM refund_requests/, () => []],
      [/^INSERT INTO refund_requests/, () => [refundRow()]],
    ]);
    await expect(svc.createForTenant(IDS.deposit)).resolves.toEqual({
      created: true,
      view: {
        refundRequestId: IDS.payout,
        depositId: IDS.deposit,
        amountVnd: 2_100_000,
        requesterType: 'TENANT',
        status: 'PENDING_ADMIN',
      },
    });
    expect(calls).toHaveLength(3);
    expect(calls[2].params).toEqual([IDS.deposit, IDS.tenant, 2_100_000]);
  });

  it('test 2: đã có yêu cầu đang mở / thất bại / đã xong → trả lại (created false), không INSERT', async () => {
    const { svc, calls } = setup([
      [/FROM payment_orders WHERE deposit_id/, () => [PAID_ORDER]],
      [/^SELECT \* FROM refund_requests/, () => [refundRow({ status: 'FAILED' })]],
    ]);
    const r = await svc.createForTenant(IDS.deposit);
    expect(r.created).toBe(false);
    expect(r.view.status).toBe('FAILED');
    expect(calls.some((c) => c.sql.startsWith('INSERT'))).toBe(false);
  });

  it('test 17: yêu cầu cũ REJECTED không tính là "đã có" (truy vấn chỉ lấy PENDING_ADMIN, FAILED, COMPLETED)', async () => {
    const { svc, calls } = setup([
      [/FROM payment_orders WHERE deposit_id/, () => [PAID_ORDER]],
      [/^SELECT \* FROM refund_requests/, () => []],
      [/^INSERT INTO refund_requests/, () => [refundRow()]],
    ]);
    await svc.createForTenant(IDS.deposit);
    expect(calls[1].sql).toContain("requester_type = 'TENANT'");
    expect(calls[1].sql).toContain("status IN ('PENDING_ADMIN','FAILED','COMPLETED')");
  });

  it('hai lời gọi cùng lúc: INSERT vướng ux_refund_tenant_active → đọc lại → created false', async () => {
    let reads = 0;
    const { svc } = setup([
      [/FROM payment_orders WHERE deposit_id/, () => [PAID_ORDER]],
      [/^SELECT \* FROM refund_requests/, () => (reads++ === 0 ? [] : [refundRow()])],
      [
        /^INSERT INTO refund_requests/,
        () => {
          throw uniqueViolation('ux_refund_tenant_active');
        },
      ],
    ]);
    await expect(svc.createForTenant(IDS.deposit)).resolves.toMatchObject({ created: false });
  });

  it('không có order → 404 PAYMENT_ORDER_NOT_FOUND; order chưa PAID → 409 PAYMENT_ORDER_NOT_PAID', async () => {
    expect(
      await fails(setup([[/FROM payment_orders/, () => []]]).svc.createForTenant(IDS.deposit)),
    ).toEqual(['PAYMENT_ORDER_NOT_FOUND', 404]);
    expect(
      await fails(
        setup([
          [/FROM payment_orders/, () => [{ ...PAID_ORDER, status: 'PENDING' }]],
        ]).svc.createForTenant(IDS.deposit),
      ),
    ).toEqual(['PAYMENT_ORDER_NOT_PAID', 409]);
  });
});

/** Dòng đọc trước khi hoàn tất: yêu cầu hoàn + chủ trọ của order. */
const adminRow = (over: Record<string, unknown> = {}) => ({
  ...refundRow(over),
  order_owner_id: IDS.owner,
});

describe('RefundService.complete (route 8, §1.2)', () => {
  const okRoutes = (status = 'PENDING_ADMIN', requester = 'TENANT'): Route[] => [
    [
      /^SELECT r\.\*, o\.owner_id AS order_owner_id/,
      () => [adminRow({ status, requester_type: requester })],
    ],
    [/^INSERT INTO transfer_receipts/, () => [{ id: IDS.receipt }]],
    [
      /^UPDATE refund_requests SET status = 'COMPLETED'/,
      () => [
        [
          refundRow({
            status: 'COMPLETED',
            requester_type: requester,
            receipt_id: IDS.receipt,
            processed_by: IDS.admin,
            processed_at: CREATED,
          }),
        ],
        1,
      ],
    ],
  ];

  it('test 3: TENANT → lưu chứng từ, COMPLETED, REFUND_OUT (có chủ trọ), audit, 1 payment.refunded; 3 truy vấn ở đây + ví 2 + audit + outbox = 7', async () => {
    const { svc, calls, wallet, audit, outbox, receipts, dataSource } = setup(okRoutes());
    const r = await svc.complete(IDS.admin, IDS.payout, FILE);
    expect(r.status).toBe('COMPLETED');
    expect(receipts.store).toHaveBeenCalledWith(FILE);
    expect(dataSource.transaction).toHaveBeenCalledTimes(1);
    expect(calls).toHaveLength(3);
    expect(calls[1].params).toEqual(['a'.repeat(64), `receipts/${'a'.repeat(64)}.png`, IDS.admin]);
    expect(calls[2].sql).toContain("WHERE id = $1 AND status IN ('PENDING_ADMIN','FAILED')");
    expect(wallet.debit).toHaveBeenCalledWith(expect.anything(), {
      type: 'REFUND_OUT',
      amountVnd: 2_100_000,
      depositId: IDS.deposit,
      refType: 'REFUND',
      refId: IDS.payout,
      tenantId: IDS.tenant,
      ownerId: IDS.owner,
    });
    expect(audit.log).toHaveBeenCalledWith(expect.anything(), {
      actorId: IDS.admin,
      action: 'COMPLETE_REFUND',
      targetType: 'REFUND',
      targetId: IDS.payout,
      before: { status: 'PENDING_ADMIN' },
      after: { status: 'COMPLETED', receiptId: IDS.receipt },
    });
    expect(outbox.add).toHaveBeenCalledTimes(1);
    expect(outbox.add).toHaveBeenCalledWith(expect.anything(), 'payment.refunded', {
      depositId: IDS.deposit,
      refundRequestId: IDS.payout,
      tenantId: IDS.tenant,
      ownerId: IDS.owner,
      amountVnd: 2_100_000,
      requesterType: 'TENANT',
    });
  });

  it('SYSTEM (tiền đến muộn): ví không gắn chủ trọ; sự kiện vẫn phát, requesterType SYSTEM (B8)', async () => {
    const { svc, wallet, outbox } = setup(okRoutes('PENDING_ADMIN', 'SYSTEM'));
    await svc.complete(IDS.admin, IDS.payout, FILE);
    expect(wallet.debit).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ ownerId: null }),
    );
    expect(outbox.add).toHaveBeenCalledWith(
      expect.anything(),
      'payment.refunded',
      expect.objectContaining({ requesterType: 'SYSTEM', ownerId: IDS.owner }),
    );
  });

  it('test 5: yêu cầu FAILED hoàn tất lại được', async () => {
    const { svc, audit } = setup(okRoutes('FAILED'));
    await expect(svc.complete(IDS.admin, IDS.payout, FILE)).resolves.toMatchObject({
      status: 'COMPLETED',
    });
    expect(audit.log).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ before: { status: 'FAILED' } }),
    );
  });

  it('không có → 404 PAYMENT_PAYOUT_NOT_FOUND; COMPLETED/REJECTED → 409 INVALID_STATUS; cả hai KHÔNG lưu chứng từ', async () => {
    const a = setup([[/^SELECT r\.\*/, () => []]]);
    expect(await fails(a.svc.complete(IDS.admin, IDS.payout, FILE))).toEqual([
      'PAYMENT_PAYOUT_NOT_FOUND',
      404,
    ]);
    expect(a.receipts.store).not.toHaveBeenCalled();
    for (const status of ['COMPLETED', 'REJECTED']) {
      const b = setup([[/^SELECT r\.\*/, () => [adminRow({ status })]]]);
      expect(await fails(b.svc.complete(IDS.admin, IDS.payout, FILE))).toEqual([
        'PAYMENT_PAYOUT_INVALID_STATUS',
        409,
      ]);
      expect(b.receipts.store).not.toHaveBeenCalled();
    }
  });

  it('test 9: chứng từ đã dùng (sha256 trùng) → 409 PAYMENT_RECEIPT_ALREADY_USED, không trừ ví', async () => {
    const routes = okRoutes();
    routes[1] = [
      /^INSERT INTO transfer_receipts/,
      () => {
        throw uniqueViolation('transfer_receipts_sha256_key');
      },
    ];
    const { svc, wallet, outbox } = setup(routes);
    expect(await fails(svc.complete(IDS.admin, IDS.payout, FILE))).toEqual([
      'PAYMENT_RECEIPT_ALREADY_USED',
      409,
    ]);
    expect(wallet.debit).not.toHaveBeenCalled();
    expect(outbox.add).not.toHaveBeenCalled();
  });

  it('hai quản trị viên cùng bấm: UPDATE 0 dòng → 409 INVALID_STATUS, không trừ ví (cả transaction rollback)', async () => {
    const routes = okRoutes();
    routes[2] = [/^UPDATE refund_requests/, () => [[], 0]];
    const { svc, wallet } = setup(routes);
    expect(await fails(svc.complete(IDS.admin, IDS.payout, FILE))).toEqual([
      'PAYMENT_PAYOUT_INVALID_STATUS',
      409,
    ]);
    expect(wallet.debit).not.toHaveBeenCalled();
  });
});

describe('RefundService.reject, fail (route 9, 10, §1.3)', () => {
  const updated = (status: string, reason: string) => [
    [
      {
        ...refundRow({ status, reason, processed_by: IDS.admin, processed_at: CREATED }),
        order_owner_id: IDS.owner,
        old_status: 'PENDING_ADMIN',
      },
    ],
    1,
  ];

  it('test 4: từ chối → REJECTED, audit, 1 payment.refund-rejected {reason}; ví không đổi; 1 UPDATE (+audit, outbox)', async () => {
    const { svc, calls, wallet, audit, outbox } = setup([
      [/^UPDATE refund_requests r SET status = 'REJECTED'/, () => updated('REJECTED', 'Quá hạn')],
    ]);
    const r = await svc.reject(IDS.admin, IDS.payout, 'Quá hạn');
    expect(r.status).toBe('REJECTED');
    expect(calls).toHaveLength(1);
    expect(calls[0].sql).toContain("r.status IN ('PENDING_ADMIN','FAILED')");
    expect(wallet.debit).not.toHaveBeenCalled();
    expect(audit.log).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: 'REJECT_REFUND',
        before: { status: 'PENDING_ADMIN' },
        after: { status: 'REJECTED', reason: 'Quá hạn' },
      }),
    );
    expect(outbox.add).toHaveBeenCalledWith(expect.anything(), 'payment.refund-rejected', {
      depositId: IDS.deposit,
      refundRequestId: IDS.payout,
      tenantId: IDS.tenant,
      ownerId: IDS.owner,
      reason: 'Quá hạn',
    });
  });

  it('thất bại → FAILED, audit FAIL_REFUND, KHÔNG phát sự kiện (đã chốt 2026-11-16)', async () => {
    const { svc, audit, outbox, calls } = setup([
      [
        /^UPDATE refund_requests r SET status = 'FAILED'/,
        () => updated('FAILED', 'Sai số tài khoản'),
      ],
    ]);
    await expect(svc.fail(IDS.admin, IDS.payout, 'Sai số tài khoản')).resolves.toMatchObject({
      status: 'FAILED',
    });
    expect(calls[0].sql).toContain("r.status IN ('PENDING_ADMIN')");
    expect(audit.log).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ action: 'FAIL_REFUND', before: { status: 'PENDING_ADMIN' } }),
    );
    expect(outbox.add).not.toHaveBeenCalled();
  });

  it('0 dòng: không có → 404, có nhưng sai trạng thái → 409 (đọc lại một lần)', async () => {
    const none = setup([
      [/^UPDATE refund_requests/, () => [[], 0]],
      [/^SELECT status FROM refund_requests/, () => []],
    ]);
    expect(await fails(none.svc.reject(IDS.admin, IDS.payout, 'x'))).toEqual([
      'PAYMENT_PAYOUT_NOT_FOUND',
      404,
    ]);
    const done = setup([
      [/^UPDATE refund_requests/, () => [[], 0]],
      [/^SELECT status FROM refund_requests/, () => [{ status: 'COMPLETED' }]],
    ]);
    expect(await fails(done.svc.fail(IDS.admin, IDS.payout, 'x'))).toEqual([
      'PAYMENT_PAYOUT_INVALID_STATUS',
      409,
    ]);
    expect(done.audit.log).not.toHaveBeenCalled();
  });
});
