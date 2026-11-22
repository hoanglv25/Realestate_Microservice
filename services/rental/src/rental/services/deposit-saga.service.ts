import { Inject, Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { randomUUID } from 'node:crypto';
import { DataSource, Repository } from 'typeorm';
import { OutboxService } from '../../messaging/outbox.service';
import { classifyCall } from '../clients/call-outcome';
import { ListingClient } from '../clients/listing.client';
import { PaymentClient } from '../clients/payment.client';
import type { CreatedOrder } from '../clients/payment.client';
import { DepositCreatedDto } from '../dto/deposit.dto';
import { Deposit } from '../entities/deposit.entity';
import { SagaLog } from '../entities/saga-log.entity';
import { isUniqueViolation, listingNotAvailable } from '../errors/rental.errors';
import { ListingLock } from '../locks/listing.lock';
import { CompensationService } from './compensation.service';
import { errorDetail, sagaLogRow } from './saga-log';

export interface DepositSagaConfig {
  /** `HOLD_TTL_SECONDS` (BR-07). */
  holdTtlSeconds: number;
}
export const DEPOSIT_SAGA_CONFIG = Symbol('DEPOSIT_SAGA_CONFIG');

const ACTIVE_UNIQUE = 'ux_deposits_active_listing';

/**
 * Saga đặt cọc điều phối tại rental (ADR-0004, `RE.DEPOSIT_SAGA/API_Spec.md §1`, `Component_Class_Design.md §4`).
 *
 * Thứ tự: khóa Redis theo tin → bản chụp listing → giữ chỗ ở listing (không retry) → transaction [đơn
 * `PENDING_PAYMENT` + `saga_log HOLD_LISTING OK` + outbox `rental.deposit-created`] → tạo order ở payment →
 * transaction [lưu order + `saga_log CREATE_PAYMENT_ORDER OK`] → nhả khóa. Không transaction nào bao lời gọi HTTP.
 * Giữ chỗ trước khi tạo đơn: giữ chỗ không rõ kết quả thì chưa có đơn nào để dọn, `held_until` tự hết.
 * Tạo đơn trước khi gọi payment: rental chết sau khi payment tạo link thì đơn trong DB là manh mối cho job.
 *
 * Tạo order lỗi (T3.3, `Component_Class_Design §4, §5`): payment chắc chắn chưa có order (`BUSINESS_ERROR`,
 * `NOT_EXECUTED`) → bù trừ (`CompensationService`: đơn `CANCELLED`, tin về `AVAILABLE`) rồi ném lỗi gốc; không rõ
 * (`UNKNOWN`: timeout, 5xx) → `saga_log UNKNOWN`, đơn giữ `PENDING_PAYMENT`, `SagaReconcileJob` (a) đối soát.
 * Truy vấn: thành công 5 (INSERT đơn, `saga_log`, outbox; UPDATE order, INSERT `saga_log`); nhánh bù trừ 7 (3 +
 * bù trừ 3 + đánh dấu đã đẩy 1, A chấp nhận 2026-11-22).
 */
@Injectable()
export class DepositSagaService {
  private readonly logger = new Logger(DepositSagaService.name);

  constructor(
    private readonly dataSource: DataSource,
    @InjectRepository(SagaLog) private readonly sagaLogs: Repository<SagaLog>,
    private readonly lock: ListingLock,
    private readonly listing: ListingClient,
    private readonly payment: PaymentClient,
    private readonly outbox: OutboxService,
    @Inject(DEPOSIT_SAGA_CONFIG) private readonly config: DepositSagaConfig,
    @Inject(CompensationService) private readonly compensation: CompensationService,
  ) {}

  async start(tenantId: string, listingId: string): Promise<DepositCreatedDto> {
    const token = await this.lock.acquire(listingId); // 409 RENTAL_DEPOSIT_IN_PROGRESS
    try {
      const snap = await this.listing.getSnapshot(listingId); // 404/503/504 chuyển nguyên
      if (snap.approvalStatus !== 'APPROVED' || snap.status !== 'AVAILABLE') {
        throw listingNotAvailable();
      }
      const depositId = randomUUID();
      const expiresAt = new Date(Date.now() + this.config.holdTtlSeconds * 1000);
      await this.listing.hold(listingId, depositId, expiresAt); // không retry; lỗi chuyển nguyên, chưa có đơn

      const deposit: Partial<Deposit> & Pick<Deposit, 'id' | 'expiresAt'> = {
        id: depositId,
        listingId,
        tenantId,
        ownerId: snap.ownerId,
        listingTitle: snap.title,
        amountVnd: snap.depositAmountVnd, // BR-04: bản chụp, không nhận từ client
        status: 'PENDING_PAYMENT',
        expiresAt,
      };
      try {
        await this.dataSource.transaction(async (m) => {
          await m.insert(Deposit, deposit);
          await m.insert(SagaLog, sagaLogRow(depositId, 'HOLD_LISTING', 'OK'));
          await this.outbox.add(m, 'rental.deposit-created', {
            depositId,
            listingId,
            tenantId,
            ownerId: snap.ownerId,
            amountVnd: snap.depositAmountVnd,
            expiresAt: expiresAt.toISOString(),
          });
        });
      } catch (err) {
        // Chưa có đơn: nhả chỗ best-effort (Processing_Flow §3 "Ghi đơn"); lớp chặn 3 → 409
        await this.releaseBestEffort(listingId, depositId);
        if (isUniqueViolation(err, ACTIVE_UNIQUE)) throw listingNotAvailable();
        throw err;
      }

      const order = await this.createOrder(deposit as Deposit);
      return {
        depositId,
        status: 'PENDING_PAYMENT',
        listingId,
        amountVnd: snap.depositAmountVnd,
        expiresAt: expiresAt.toISOString(),
        holdRemainingSeconds: Math.max(0, Math.floor((expiresAt.getTime() - Date.now()) / 1000)),
        checkoutUrl: order.checkoutUrl,
        qrCode: order.qrCode,
      };
    } finally {
      await this.lock.release(listingId, token);
    }
  }

  /** Bước 6–7. Lỗi: theo `CallOutcome` (C14) — bù trừ hoặc `saga_log UNKNOWN` — rồi ném nguyên lỗi. */
  private async createOrder(d: Deposit): Promise<CreatedOrder> {
    let order: CreatedOrder;
    try {
      order = await this.payment.createOrder({
        depositId: d.id,
        tenantId: d.tenantId,
        ownerId: d.ownerId,
        listingTitle: d.listingTitle,
        amountVnd: d.amountVnd,
        expiresAt: d.expiresAt,
      });
    } catch (err) {
      const outcome = classifyCall(err);
      if (outcome === 'BUSINESS_ERROR' || outcome === 'NOT_EXECUTED') {
        // Payment chắc chắn chưa có order: bù trừ ngay (saga_log nằm trong transaction bù trừ)
        await this.compensation
          .cancelAfterHold(d, {
            step: 'CREATE_PAYMENT_ORDER',
            outcome,
            detail: errorDetail(err),
            reason: outcome === 'BUSINESS_ERROR' ? 'PAYMENT_ORDER_REJECTED' : 'PAYMENT_UNAVAILABLE',
          })
          .catch((e: unknown) =>
            // Bù trừ lỗi (DB): đơn giữ PENDING_PAYMENT, job (a) xử lý; không che lỗi gốc
            this.logger.warn(`Bù trừ đơn ${d.id} lỗi, chờ job đối soát: ${(e as Error).message}`),
          );
        throw err;
      }
      await this.sagaLogs
        .insert(sagaLogRow(d.id, 'CREATE_PAYMENT_ORDER', outcome, errorDetail(err)))
        .catch(() => this.logger.warn(`Không ghi được saga_log cho đơn ${d.id}`));
      throw err;
    }
    await this.dataSource.transaction(async (m) => {
      await m.update(
        Deposit,
        { id: d.id },
        { paymentOrderId: order.orderId, checkoutUrl: order.checkoutUrl, qrCode: order.qrCode },
      );
      await m.insert(SagaLog, sagaLogRow(d.id, 'CREATE_PAYMENT_ORDER', 'OK'));
    });
    return order;
  }

  private async releaseBestEffort(listingId: string, depositId: string): Promise<void> {
    try {
      await this.listing.changeStatus(listingId, depositId, 'AVAILABLE');
    } catch {
      // held_until ở listing tự hết; không che lỗi gốc
      this.logger.warn(
        `Không nhả được chỗ của tin ${listingId} (đơn ${depositId}), chờ held_until hết`,
      );
    }
  }
}
