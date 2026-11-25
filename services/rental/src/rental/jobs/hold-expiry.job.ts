import { Inject, Injectable } from '@nestjs/common';
import { SchedulerRegistry } from '@nestjs/schedule';
import { InjectDataSource, InjectRepository } from '@nestjs/typeorm';
import { DataSource, LessThan, Repository } from 'typeorm';
import { OutboxService } from '../../messaging/outbox.service';
import { classifyCall } from '../clients/call-outcome';
import { PaymentClient } from '../clients/payment.client';
import { Deposit } from '../entities/deposit.entity';
import { SagaLog } from '../entities/saga-log.entity';
import { ListingSyncService } from '../services/listing-sync.service';
import { errorDetail, sagaLogRow } from '../services/saga-log';
import { IntervalJob } from './interval-job';

export interface HoldExpiryConfig {
  /** `HOLD_EXPIRY_INTERVAL_MS`; `0` tắt (test gọi `runOnce`). */
  intervalMs: number;
}
export const HOLD_EXPIRY_CONFIG = Symbol('HOLD_EXPIRY_CONFIG');

/** Payload `contracts/events/rental.deposit-expired.v1.schema.json`. */
export interface DepositExpiredPayload {
  depositId: string;
  listingId: string;
  tenantId: string;
  ownerId: string;
}

export interface ExpiryResult {
  /** Đã chuyển `EXPIRED`. */
  expired: number;
  /** Payment báo order đã `PAID` (`409`): chờ `payment.deposited`. */
  paid: number;
  /** Hủy order chưa chắc thành công: giữ `PENDING_PAYMENT`, lượt sau thử lại. */
  retry: number;
  /** `UPDATE` 0 dòng: đơn vừa đổi trạng thái ở nơi khác. */
  skipped: number;
  /** Lỗi DB khi ghi `EXPIRED`. */
  failed: number;
}

const JOB_NAME = 'hold-expiry';
/** Tối đa mỗi lượt (`Component_Class_Design §7`). */
const BATCH = 50;

/**
 * `HoldExpiryJob` — hết hạn giữ chỗ, BR-09 (`RE.DEPOSIT_SAGA/Processing_Flow.md §4`, `Component_Class_Design.md §7`,
 * chốt T3.4b 2026-11-25). Mỗi `HOLD_EXPIRY_INTERVAL_MS`, lấy tối đa 50 đơn `PENDING_PAYMENT` quá `expires_at` (hết hạn
 * sớm nhất trước, `ix_deposits_expiry`), với từng đơn:
 *
 * 1. **Hủy link trước**: `POST /internal/payment-orders/:depositId/cancel`.
 *    - `200` (đã hủy) hoặc `404 PAYMENT_ORDER_NOT_FOUND` (payment chưa có order) → bước 2.
 *    - `409 PAYMENT_ORDER_ALREADY_PAID` (webhook thắng) → bỏ qua, log `info`; `payment.deposited` sẽ đưa đơn sang `PAID`
 *      (test 12).
 *    - Mọi lỗi khác (`503`/`504`/kết nối, 4xx lạ) → giữ `PENDING_PAYMENT`, log `warn`, lượt sau thử lại: chưa chắc link
 *      đã hủy thì không nhả chỗ (test 13).
 * 2. **Một transaction**: `UPDATE ... WHERE status='PENDING_PAYMENT'` → `EXPIRED`, đích listing `AVAILABLE`;
 *    `saga_log CANCEL_PAYMENT_ORDER OK {status}`; outbox `rental.deposit-expired`. `UPDATE` 0 dòng → dừng.
 * 3. **Nhả chỗ sau**: đẩy `AVAILABLE` sang listing (`ListingSyncService.push`, C20); lỗi tạm thì `SagaReconcileJob` (b)
 *    đẩy lại.
 *
 * Truy vấn: 1 `SELECT` mỗi lượt; mỗi đơn hết hạn 3 (transaction) + 1 (đánh dấu đã đẩy) = 4, C20 thì 5. Không giữ
 * transaction khi gọi HTTP. Một đơn lỗi không chặn đơn khác.
 */
@Injectable()
export class HoldExpiryJob extends IntervalJob {
  constructor(
    @InjectRepository(Deposit) private readonly deposits: Repository<Deposit>,
    @InjectDataSource() private readonly dataSource: DataSource,
    @Inject(PaymentClient) private readonly payment: PaymentClient,
    @Inject(OutboxService) private readonly outbox: OutboxService,
    @Inject(ListingSyncService) private readonly sync: ListingSyncService,
    @Inject(SchedulerRegistry) scheduler: SchedulerRegistry,
    @Inject(HOLD_EXPIRY_CONFIG) config: HoldExpiryConfig,
  ) {
    super(scheduler, JOB_NAME, config.intervalMs);
  }

  async runOnce(): Promise<ExpiryResult> {
    const r: ExpiryResult = { expired: 0, paid: 0, retry: 0, skipped: 0, failed: 0 };
    const due = await this.deposits.find({
      where: { status: 'PENDING_PAYMENT', expiresAt: LessThan(new Date()) },
      order: { expiresAt: 'ASC' },
      take: BATCH,
    });

    for (const d of due) {
      // 1. Hủy link trước (BR-09)
      let cancelStatus: 200 | 404;
      try {
        await this.payment.cancelOrder(d.id);
        cancelStatus = 200;
      } catch (err) {
        const detail = errorDetail(err);
        const business = classifyCall(err) === 'BUSINESS_ERROR';
        if (business && detail.code === 'PAYMENT_ORDER_NOT_FOUND') {
          cancelStatus = 404;
        } else if (business && detail.code === 'PAYMENT_ORDER_ALREADY_PAID') {
          r.paid++;
          this.logger.log(`Đơn ${d.id} quá hạn nhưng đã thanh toán: chờ payment.deposited`);
          continue;
        } else {
          r.retry++;
          this.logger.warn(
            `Chưa hủy được order của đơn ${d.id}, giữ chỗ, lượt sau thử lại: ${JSON.stringify(detail)}`,
          );
          continue;
        }
      }

      // 2. EXPIRED + đích AVAILABLE + saga_log + outbox, một transaction
      let expired: boolean;
      try {
        expired = await this.dataSource.transaction(async (m) => {
          const { affected } = await m.update(
            Deposit,
            { id: d.id, status: 'PENDING_PAYMENT' },
            { status: 'EXPIRED', listingTargetStatus: 'AVAILABLE', listingSyncedAt: null },
          );
          if (!affected) return false;
          await m.insert(
            SagaLog,
            sagaLogRow(d.id, 'CANCEL_PAYMENT_ORDER', 'OK', { status: cancelStatus }),
          );
          await this.outbox.add<DepositExpiredPayload>(m, 'rental.deposit-expired', {
            depositId: d.id,
            listingId: d.listingId,
            tenantId: d.tenantId,
            ownerId: d.ownerId,
          });
          return true;
        });
      } catch (err) {
        r.failed++;
        this.logger.warn(
          `Ghi EXPIRED cho đơn ${d.id} lỗi, lượt sau thử lại: ${(err as Error).message}`,
        );
        continue;
      }
      if (!expired) {
        r.skipped++;
        this.logger.log(`Đơn ${d.id} không còn PENDING_PAYMENT khi ghi EXPIRED: bỏ qua`);
        continue;
      }
      r.expired++;

      // 3. Nhả chỗ sau
      try {
        await this.sync.push({
          id: d.id,
          listingId: d.listingId,
          listingTargetStatus: 'AVAILABLE',
        });
      } catch (err) {
        // Đơn đã EXPIRED; đích AVAILABLE nằm trong DB, SagaReconcileJob (b) đẩy lại
        this.logger.warn(
          `Chưa đẩy được AVAILABLE cho đơn ${d.id} sau khi hết hạn: ${(err as Error).message}`,
        );
      }
    }
    return r;
  }
}
