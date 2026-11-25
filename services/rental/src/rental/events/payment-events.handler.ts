import { Inject, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { EntityManager, IsNull } from 'typeorm';
import type { DomainEvent } from '../../messaging/domain-event';
import { EventHandlerRegistry } from '../../messaging/event-handler.registry';
import { Deposit } from '../entities/deposit.entity';
import { ViewingService } from '../services/viewing.service';

/** Payload `payment.deposited` v1 (`contracts/events/payment.deposited.v1.schema.json`). */
export interface PaymentDepositedPayload {
  depositId: string;
  orderId: string;
  tenantId: string;
  ownerId: string;
  amountVnd: number;
  payosReference: string;
  paidAt: string;
}

/** Payload `payment.refunded` v1. `SYSTEM`: hoàn tiền đến muộn của đơn đã `EXPIRED` (BR-10). */
export interface PaymentRefundedPayload {
  depositId: string;
  refundRequestId: string;
  tenantId: string;
  ownerId: string;
  amountVnd: number;
  requesterType: 'TENANT' | 'SYSTEM';
}

/** Payload `payment.refund-rejected` v1. */
export interface PaymentRefundRejectedPayload {
  depositId: string;
  refundRequestId: string;
  tenantId: string;
  ownerId: string;
  reason: string;
}

/** Payload `payment.withdrawal-completed` v1. */
export interface PaymentWithdrawalCompletedPayload {
  withdrawalId: string;
  depositId: string;
  ownerId: string;
  amountVnd: number;
}

export interface PaymentEventsConfig {
  /** `REFUND_WINDOW_SECONDS` (48 giờ). */
  refundWindowSeconds: number;
  /** `AUTO_RELEASE_SECONDS` (72 giờ). */
  autoReleaseSeconds: number;
}
export const PAYMENT_EVENTS_CONFIG = Symbol('PAYMENT_EVENTS_CONFIG');

const addSeconds = (d: Date, s: number): Date => new Date(d.getTime() + s * 1000);

/**
 * Nghe queue `rental.payment-events`: `payment.deposited` (`RE.DEPOSIT_SAGA/Component_Class_Design.md §6`, T3.2);
 * `payment.refunded`, `payment.refund-rejected`, `payment.withdrawal-completed` (`RE.DEPOSIT_LIFECYCLE/API_Spec.md §4`,
 * T3.5). Đúng 4 khóa đã bind trong `infra/rabbitmq/definitions.json`; rental KHÔNG nghe `withdrawal-requested`,
 * `withdrawal-failed` (C10). Mọi chuyển là `UPDATE ... WHERE status = <từ>`: sự kiện trùng hoặc sai thứ tự đổi 0 dòng
 * → log, không đổi sai.
 *
 * `EventConsumer` của template đã ghi `eventId` vào `processed_events` trong CÙNG transaction `m` (giao hai lần
 * thì bỏ qua). Handler chỉ dùng `m`, không gọi HTTP: đẩy `DEPOSITED`/`AVAILABLE` sang listing là việc của job (b).
 */
@Injectable()
export class PaymentEventsHandler implements OnModuleInit {
  private readonly logger = new Logger(PaymentEventsHandler.name);

  constructor(
    private readonly events: EventHandlerRegistry,
    private readonly viewings: ViewingService,
    @Inject(PAYMENT_EVENTS_CONFIG) private readonly config: PaymentEventsConfig,
  ) {}

  onModuleInit(): void {
    this.events.on<PaymentDepositedPayload>('payment.deposited', (e, m) => this.onDeposited(e, m));
    this.events.on<PaymentRefundedPayload>('payment.refunded', (e, m) => this.onRefunded(e, m));
    this.events.on<PaymentRefundRejectedPayload>('payment.refund-rejected', (e, m) =>
      this.onRefundRejected(e, m),
    );
    this.events.on<PaymentWithdrawalCompletedPayload>('payment.withdrawal-completed', (e, m) =>
      this.onWithdrawalCompleted(e, m),
    );
  }

  /**
   * `TENANT`: `REFUND_REQUESTED → REFUNDED` (test 6), `refunded_at` = lúc payment hoàn xong, đích listing `AVAILABLE`.
   * `SYSTEM`: hoàn tiền đến muộn của đơn `EXPIRED` — đơn không đổi (test 7).
   */
  private async onRefunded(
    e: DomainEvent<PaymentRefundedPayload>,
    m: EntityManager,
  ): Promise<void> {
    const { depositId, requesterType } = e.payload;
    if (requesterType === 'SYSTEM') {
      this.logger.log(
        `payment.refunded SYSTEM (tiền đến muộn) cho đơn ${depositId}: đơn không đổi`,
      );
      return;
    }
    const { affected } = await m.update(
      Deposit,
      { id: depositId, status: 'REFUND_REQUESTED' },
      {
        status: 'REFUNDED',
        refundedAt: new Date(e.occurredAt),
        listingTargetStatus: 'AVAILABLE',
        listingSyncedAt: null,
      },
    );
    if (!affected) {
      this.logger.warn(`payment.refunded cho đơn ${depositId} không còn REFUND_REQUESTED: bỏ qua`);
    }
  }

  /**
   * `REFUND_REQUESTED → PAID` (test 8). Mốc `auto_release_at` giữ nguyên: đã quá 72 giờ thì `AutoReleaseJob` giải
   * ngân ở lượt kế tiếp (`Component_Class_Design §4`, Báo cáo §3.3).
   */
  private async onRefundRejected(
    e: DomainEvent<PaymentRefundRejectedPayload>,
    m: EntityManager,
  ): Promise<void> {
    const { depositId } = e.payload;
    const { affected } = await m.update(
      Deposit,
      { id: depositId, status: 'REFUND_REQUESTED' },
      { status: 'PAID' },
    );
    if (!affected) {
      this.logger.warn(
        `payment.refund-rejected cho đơn ${depositId} không còn REFUND_REQUESTED: bỏ qua`,
      );
    }
  }

  /**
   * `RELEASED → WITHDRAWN` (test 14). Đơn `REFUNDED` (chủ trọ rút phần còn lại, BR-15 sửa): giữ `REFUNDED`, chỉ đặt
   * `withdrawn_at` nếu còn trống.
   */
  private async onWithdrawalCompleted(
    e: DomainEvent<PaymentWithdrawalCompletedPayload>,
    m: EntityManager,
  ): Promise<void> {
    const { depositId } = e.payload;
    const withdrawnAt = new Date(e.occurredAt);
    const released = await m.update(
      Deposit,
      { id: depositId, status: 'RELEASED' },
      { status: 'WITHDRAWN', withdrawnAt },
    );
    if (released.affected) return;
    const refunded = await m.update(
      Deposit,
      { id: depositId, status: 'REFUNDED', withdrawnAt: IsNull() },
      { withdrawnAt },
    );
    if (!refunded.affected) {
      this.logger.warn(
        `payment.withdrawal-completed cho đơn ${depositId} không ở RELEASED/REFUNDED chưa rút: bỏ qua`,
      );
    }
  }

  /**
   * `PENDING_PAYMENT → PAID`, đặt mốc 48h/72h tính từ `paidAt`, đích listing `DEPOSITED`; rồi hủy yêu cầu xem
   * `REQUESTED` của người khác trên tin (chốt 2026-11-16, `RE.VIEWING`). UPDATE 0 dòng: đã xử lý (trùng) hoặc đơn
   * đã đổi trạng thái (ví dụ `EXPIRED`: tiền đến muộn, payment xử lý theo BR-10) → log `warn`, không làm gì.
   */
  private async onDeposited(
    e: DomainEvent<PaymentDepositedPayload>,
    m: EntityManager,
  ): Promise<void> {
    const { depositId } = e.payload;
    const paidAt = new Date(e.payload.paidAt);
    const { affected } = await m.update(
      Deposit,
      { id: depositId, status: 'PENDING_PAYMENT' },
      {
        status: 'PAID',
        paidAt,
        refundDeadlineAt: addSeconds(paidAt, this.config.refundWindowSeconds),
        autoReleaseAt: addSeconds(paidAt, this.config.autoReleaseSeconds),
        listingTargetStatus: 'DEPOSITED',
        listingSyncedAt: null,
      },
    );
    if (!affected) {
      this.logger.warn(`payment.deposited cho đơn ${depositId} không còn PENDING_PAYMENT: bỏ qua`);
      return;
    }
    const d = await m.findOneByOrFail(Deposit, { id: depositId }); // payload không có listingId
    await this.viewings.cancelOthersOnDeposit(m, d.listingId, d.tenantId);
  }
}
