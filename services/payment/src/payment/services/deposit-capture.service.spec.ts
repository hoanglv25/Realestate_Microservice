import type { PaymentOrder } from '../entities/payment-order.entity';
import { DepositCaptureService } from './deposit-capture.service';

const ORDER: PaymentOrder = {
  id: '22222222-2222-4222-8222-222222222222',
  depositId: '11111111-1111-4111-8111-111111111111',
  tenantId: '33333333-3333-4333-8333-333333333333',
  ownerId: '44444444-4444-4444-8444-444444444444',
  listingTitle: 'Phòng test',
  amountVnd: 3_000_000,
  payosOrderCode: 100001,
  payosPaymentLinkId: 'link-1',
  checkoutUrl: 'https://pay.payos.vn/web/link-1',
  qrCode: '000201',
  status: 'PENDING',
  payosReference: null,
  expiresAt: new Date('2026-11-22T15:27:11.493Z'),
  paidAt: null,
  cancelledAt: null,
  createdAt: new Date(),
  updatedAt: new Date(),
};
const EV = {
  reference: 'FT25326000001',
  amountVnd: 3_000_000,
  paidAt: new Date('2026-11-22T15:20:00.000Z'),
};
const REFUND_ID = '55555555-5555-4555-8555-555555555555';

function setup(affected = 1) {
  const steps: string[] = [];
  const m = {
    update: jest.fn(async () => {
      steps.push('update-order');
      return { affected };
    }),
    query: jest.fn(async (sql: string) => {
      const s = sql.replace(/\s+/g, ' ').trim();
      steps.push(s.slice(0, 30));
      return /^INSERT INTO refund_requests/.test(s) ? [{ id: REFUND_ID }] : [];
    }),
  };
  const wallet = { credit: jest.fn(async () => steps.push('wallet')) };
  const outbox = { add: jest.fn(async () => steps.push('outbox')) };
  const service = new DepositCaptureService(wallet as never, outbox as never);
  return { service, m, wallet, outbox, steps };
}

describe('DepositCaptureService.capture (API_Spec §1.1)', () => {
  it('order PENDING: UPDATE ... WHERE status=PENDING -> PAID, paid_at, payos_reference; ví DEPOSIT_IN; payment.deposited; trả true', async () => {
    const { service, m, wallet, outbox, steps } = setup(1);
    expect(await service.capture(m as never, ORDER, EV)).toBe(true);

    expect(m.update).toHaveBeenCalledWith(
      expect.anything(),
      { id: ORDER.id, status: 'PENDING' },
      { status: 'PAID', paidAt: EV.paidAt, payosReference: EV.reference },
    );
    expect(wallet.credit).toHaveBeenCalledWith(m, {
      type: 'DEPOSIT_IN',
      amountVnd: 3_000_000,
      depositId: ORDER.depositId,
      refType: 'ORDER',
      refId: ORDER.id,
      tenantId: ORDER.tenantId,
      ownerId: ORDER.ownerId,
    });
    expect(outbox.add).toHaveBeenCalledWith(m, 'payment.deposited', {
      depositId: ORDER.depositId,
      orderId: ORDER.id,
      tenantId: ORDER.tenantId,
      ownerId: ORDER.ownerId,
      amountVnd: 3_000_000,
      payosReference: EV.reference,
      paidAt: '2026-11-22T15:20:00.000Z',
    });
    expect(steps).toEqual(['update-order', 'wallet', 'outbox']);
  });

  it('UPDATE 0 dòng (order vừa bị hủy hoặc đã PAID) -> trả false, KHÔNG cộng ví, KHÔNG phát sự kiện', async () => {
    const { service, m, wallet, outbox } = setup(0);
    expect(await service.capture(m as never, ORDER, EV)).toBe(false);
    expect(wallet.credit).not.toHaveBeenCalled();
    expect(outbox.add).not.toHaveBeenCalled();
  });
});

describe('DepositCaptureService.recordLate (API_Spec §1.2, BR-10)', () => {
  const late = { ...EV, amountVnd: 2_500_000 }; // số thực nhận, có thể khác tiền cọc

  it('yêu cầu hoàn SYSTEM 100% số THỰC NHẬN trước, rồi late_payments trỏ tới nó, ví LATE_PAYMENT_IN, late-payment-credited', async () => {
    const { service, m, wallet, outbox, steps } = setup();
    await service.recordLate(m as never, { ...ORDER, status: 'CANCELLED' }, late);

    const [refundSql, refundParams] = m.query.mock.calls[0] as unknown as [string, unknown[]];
    expect(refundSql).toMatch(/INSERT INTO refund_requests/);
    expect(refundSql).toMatch(/'SYSTEM'/);
    expect(refundParams).toEqual([ORDER.depositId, ORDER.tenantId, 2_500_000]);

    const [lateSql, lateParams] = m.query.mock.calls[1] as unknown as [string, unknown[]];
    expect(lateSql).toMatch(/INSERT INTO late_payments/);
    const lateId = lateParams[0] as string;
    expect(lateId).toMatch(/^[0-9a-f-]{36}$/);
    expect(lateParams.slice(1)).toEqual([
      ORDER.id,
      ORDER.depositId,
      2_500_000,
      late.reference,
      REFUND_ID,
    ]);

    expect(wallet.credit).toHaveBeenCalledWith(m, {
      type: 'LATE_PAYMENT_IN',
      amountVnd: 2_500_000,
      depositId: ORDER.depositId,
      refType: 'LATE_PAYMENT',
      refId: lateId,
      tenantId: ORDER.tenantId,
      ownerId: null,
    });
    expect(outbox.add).toHaveBeenCalledWith(m, 'payment.late-payment-credited', {
      orderId: ORDER.id,
      depositId: ORDER.depositId,
      tenantId: ORDER.tenantId,
      amountVnd: 2_500_000,
      payosReference: late.reference,
    });
    expect(steps.map((s) => s.split(' ').slice(0, 3).join(' '))).toEqual([
      'INSERT INTO refund_requests',
      'INSERT INTO late_payments',
      'wallet',
      'outbox',
    ]);
    expect(m.update).not.toHaveBeenCalled(); // order giữ nguyên trạng thái (đơn rental giữ EXPIRED)
  });
});
