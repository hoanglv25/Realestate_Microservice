import { Inject, Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { EntityManager } from 'typeorm';
import { OutboxService } from '../../messaging/outbox.service';
import { PaymentOrder } from '../entities/payment-order.entity';
import { WalletService } from './wallet.service';

/** Phần của webhook payOS đã được chấp nhận (chữ ký đúng, `success`, có `reference`). */
export interface AcceptedPayment {
  /** Mã giao dịch payOS (`data.reference`), duy nhất. */
  reference: string;
  /** Số tiền THỰC NHẬN (`data.amount`). */
  amountVnd: number;
  /** Thời điểm thanh toán theo payOS (`data.transactionDateTime`, giờ VN). */
  paidAt: Date;
}

/** Payload `contracts/events/payment.deposited.v1.schema.json`. */
export interface DepositedPayload {
  depositId: string;
  orderId: string;
  tenantId: string;
  ownerId: string;
  amountVnd: number;
  payosReference: string;
  paidAt: string;
}

/** Payload `contracts/events/payment.late-payment-credited.v1.schema.json`. */
export interface LatePaymentCreditedPayload {
  orderId: string;
  depositId: string;
  tenantId: string;
  amountVnd: number;
  payosReference: string;
}

const INSERT_SYSTEM_REFUND = `
  INSERT INTO refund_requests (deposit_id, tenant_id, requester_type, amount_vnd)
  VALUES ($1, $2, 'SYSTEM', $3)
  RETURNING id`;
const INSERT_LATE = `
  INSERT INTO late_payments (id, order_id, deposit_id, amount_vnd, payos_reference, refund_request_id)
  VALUES ($1, $2, $3, $4, $5, $6)`;

/**
 * Ghi nhận tiền từ webhook payOS (`RE.PAYMENT/API_Spec.md §1.1, §1.2`, `Component_Class_Design §3`).
 *
 * Mọi hàm chạy trong transaction của `WebhookService` (`manager`): đổi trạng thái order, giao dịch ví, số dư và
 * outbox cùng commit hoặc cùng rollback (ADR-0006).
 */
@Injectable()
export class DepositCaptureService {
  constructor(
    @Inject(WalletService) private readonly wallet: WalletService,
    @Inject(OutboxService) private readonly outbox: OutboxService,
  ) {}

  /**
   * §1.1. `UPDATE ... WHERE status = 'PENDING'`: đua với lệnh hủy (hết hạn giữ chỗ) thì Postgres khóa dòng, chỉ một
   * bên thắng (`Processing_Flow §3`). Trả `false` khi 0 dòng (order vừa bị hủy hoặc đã `PAID`): bên gọi ghi tiền
   * đến muộn. Truy vấn: 4 (UPDATE order, ví 2, outbox).
   */
  async capture(m: EntityManager, order: PaymentOrder, paid: AcceptedPayment): Promise<boolean> {
    const { affected } = await m.update(
      PaymentOrder,
      { id: order.id, status: 'PENDING' },
      { status: 'PAID', paidAt: paid.paidAt, payosReference: paid.reference },
    );
    if (!affected) return false;

    await this.wallet.credit(m, {
      type: 'DEPOSIT_IN',
      amountVnd: paid.amountVnd,
      depositId: order.depositId,
      refType: 'ORDER',
      refId: order.id,
      tenantId: order.tenantId,
      ownerId: order.ownerId,
    });
    await this.outbox.add<DepositedPayload>(m, 'payment.deposited', {
      depositId: order.depositId,
      orderId: order.id,
      tenantId: order.tenantId,
      ownerId: order.ownerId,
      amountVnd: paid.amountVnd,
      payosReference: paid.reference,
      paidAt: paid.paidAt.toISOString(),
    });
    return true;
  }

  /**
   * §1.2 (BR-10): tiền đến khi order đã `CANCELLED`, hoặc order đã `PAID` nhận thêm tiền với `reference` khác. Ghi
   * nhận đúng **số thực nhận**, tạo yêu cầu hoàn 100% số đó (`SYSTEM`, chờ quản trị viên). Order không đổi trạng
   * thái; đơn bên rental giữ `EXPIRED`.
   *
   * Thứ tự (A duyệt 2026-11-22): yêu cầu hoàn **trước** để `late_payments` ghi luôn `refund_request_id`, không cần
   * `UPDATE` thêm. Truy vấn: 5 (refund, late, ví 2, outbox).
   */
  async recordLate(m: EntityManager, order: PaymentOrder, paid: AcceptedPayment): Promise<void> {
    const [refund] = (await m.query(INSERT_SYSTEM_REFUND, [
      order.depositId,
      order.tenantId,
      paid.amountVnd,
    ])) as Array<{ id: string }>;
    const lateId = randomUUID();
    await m.query(INSERT_LATE, [
      lateId,
      order.id,
      order.depositId,
      paid.amountVnd,
      paid.reference,
      refund.id,
    ]);
    await this.wallet.credit(m, {
      type: 'LATE_PAYMENT_IN',
      amountVnd: paid.amountVnd,
      depositId: order.depositId,
      refType: 'LATE_PAYMENT',
      refId: lateId,
      tenantId: order.tenantId,
      ownerId: null,
    });
    await this.outbox.add<LatePaymentCreditedPayload>(m, 'payment.late-payment-credited', {
      orderId: order.id,
      depositId: order.depositId,
      tenantId: order.tenantId,
      amountVnd: paid.amountVnd,
      payosReference: paid.reference,
    });
  }
}
