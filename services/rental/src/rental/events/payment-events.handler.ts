import { Inject, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { EntityManager } from 'typeorm';
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

export interface PaymentEventsConfig {
  /** `REFUND_WINDOW_SECONDS` (48 giờ). */
  refundWindowSeconds: number;
  /** `AUTO_RELEASE_SECONDS` (72 giờ). */
  autoReleaseSeconds: number;
}
export const PAYMENT_EVENTS_CONFIG = Symbol('PAYMENT_EVENTS_CONFIG');

const addSeconds = (d: Date, s: number): Date => new Date(d.getTime() + s * 1000);

/**
 * Nghe queue `rental.payment-events` (`RE.DEPOSIT_SAGA/Component_Class_Design.md §6`). T3.2: `payment.deposited`;
 * các sự kiện khác của payment thuộc `RE.DEPOSIT_LIFECYCLE` (T3.5, T3.6).
 *
 * `EventConsumer` của template đã ghi `eventId` vào `processed_events` trong CÙNG transaction `m` (giao hai lần
 * thì bỏ qua). Handler chỉ dùng `m`, không gọi HTTP: đẩy `DEPOSITED` sang listing là việc của job (T3.3).
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
