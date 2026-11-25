import { Inject, Injectable } from '@nestjs/common';
import { SchedulerRegistry } from '@nestjs/schedule';
import { InjectDataSource, InjectRepository } from '@nestjs/typeorm';
import { DataSource, IsNull, LessThan, Not, Repository } from 'typeorm';
import { classifyCall } from '../clients/call-outcome';
import { PaymentClient } from '../clients/payment.client';
import type { ListingTargetStatus } from '../clients/listing.client';
import { Deposit } from '../entities/deposit.entity';
import { SagaLog } from '../entities/saga-log.entity';
import { CompensationService } from '../services/compensation.service';
import { ListingSyncService } from '../services/listing-sync.service';
import { errorDetail, sagaLogRow } from '../services/saga-log';
import { IntervalJob } from './interval-job';

export interface SagaReconcileConfig {
  /** `SAGA_RECONCILE_INTERVAL_MS`; `0` tắt (test gọi `runOnce`). */
  intervalMs: number;
  /** `SAGA_STUCK_AFTER_SECONDS`. */
  stuckAfterSeconds: number;
}
export const SAGA_RECONCILE_CONFIG = Symbol('SAGA_RECONCILE_CONFIG');

const JOB_NAME = 'saga-reconcile';
/** Mỗi phần mỗi lượt tối đa (A duyệt B6, 2026-11-22). */
const BATCH = 50;

export interface ReconcileResult {
  attached: number;
  cancelled: number;
  synced: number;
  rejected: number;
  retry: number;
  failed: number;
}

/**
 * `SagaReconcileJob` (`RE.DEPOSIT_SAGA/Component_Class_Design.md §7`), chạy mỗi `SAGA_RECONCILE_INTERVAL_MS`:
 *
 * - (a) Đơn `PENDING_PAYMENT` chưa có `payment_order_id`, tạo quá `SAGA_STUCK_AFTER_SECONDS` (tạo order `UNKNOWN`,
 *   hoặc rental chết giữa saga): hỏi payment `GET /internal/payment-orders/:depositId`. Có → gắn order (test 7);
 *   `404` → bù trừ, tin về `AVAILABLE` (test 8, E8); lỗi khác → lượt sau.
 * - (b) Đơn có `listing_target_status` chưa đồng bộ (bù trừ, `PAID` → `DEPOSITED`, hết hạn): `ListingSyncService.push`
 *   (test 17, C20).
 *
 * Một đơn lỗi không chặn đơn khác. Lịch chạy, bỏ lượt chồng, nuốt lỗi lượt: `IntervalJob` (T3.4b). Các thay đổi
 * đều là `UPDATE ... WHERE` theo trạng thái nên chạy lại an toàn.
 */
@Injectable()
export class SagaReconcileJob extends IntervalJob {
  constructor(
    @InjectRepository(Deposit) private readonly deposits: Repository<Deposit>,
    @InjectDataSource() private readonly dataSource: DataSource,
    @Inject(PaymentClient) private readonly payment: PaymentClient,
    @Inject(CompensationService) private readonly compensation: CompensationService,
    @Inject(ListingSyncService) private readonly sync: ListingSyncService,
    @Inject(SchedulerRegistry) scheduler: SchedulerRegistry,
    @Inject(SAGA_RECONCILE_CONFIG) private readonly config: SagaReconcileConfig,
  ) {
    super(scheduler, JOB_NAME, config.intervalMs);
  }

  async runOnce(): Promise<ReconcileResult> {
    const r: ReconcileResult = {
      attached: 0,
      cancelled: 0,
      synced: 0,
      rejected: 0,
      retry: 0,
      failed: 0,
    };

    // (a) đơn kẹt chưa có order
    const stuck = await this.deposits.find({
      where: {
        status: 'PENDING_PAYMENT',
        paymentOrderId: IsNull(),
        createdAt: LessThan(new Date(Date.now() - this.config.stuckAfterSeconds * 1000)),
      },
      order: { createdAt: 'ASC' },
      take: BATCH,
    });
    for (const d of stuck) {
      try {
        const order = await this.payment.getOrder(d.id);
        await this.dataSource.transaction(async (m) => {
          await m.update(
            Deposit,
            { id: d.id, paymentOrderId: IsNull() },
            { paymentOrderId: order.orderId, checkoutUrl: order.checkoutUrl },
          );
          await m.insert(
            SagaLog,
            sagaLogRow(d.id, 'CREATE_PAYMENT_ORDER', 'OK', { via: 'reconcile' }),
          );
        });
        r.attached++;
      } catch (err) {
        const detail = errorDetail(err);
        if (classifyCall(err) === 'BUSINESS_ERROR' && detail.code === 'PAYMENT_ORDER_NOT_FOUND') {
          const done = await this.compensation
            .cancelAfterHold(d, {
              step: 'CREATE_PAYMENT_ORDER',
              outcome: 'BUSINESS_ERROR',
              detail,
              reason: 'PAYMENT_ORDER_NOT_FOUND',
            })
            .catch((e: unknown) => {
              this.logger.warn(`Bù trừ đơn ${d.id} lỗi, lượt sau thử lại: ${(e as Error).message}`);
              return null;
            });
          if (done === null) r.failed++;
          else r.cancelled += done ? 1 : 0;
          continue;
        }
        r.failed++;
        this.logger.warn(
          `Đối soát đơn ${d.id} chưa xong, lượt sau thử lại: ${JSON.stringify(detail)}`,
        );
      }
    }

    // (b) đích listing chưa đồng bộ
    const pending = await this.deposits.find({
      where: { listingTargetStatus: Not(IsNull()), listingSyncedAt: IsNull() },
      order: { updatedAt: 'ASC' },
      take: BATCH,
    });
    for (const d of pending) {
      try {
        const res = await this.sync.push({
          id: d.id,
          listingId: d.listingId,
          listingTargetStatus: d.listingTargetStatus as ListingTargetStatus | null,
        });
        if (res === 'SYNCED') r.synced++;
        else if (res === 'REJECTED') r.rejected++;
        else if (res === 'RETRY') r.retry++;
      } catch (err) {
        r.failed++;
        this.logger.warn(`Đẩy trạng thái tin cho đơn ${d.id} lỗi: ${(err as Error).message}`);
      }
    }
    return r;
  }
}
