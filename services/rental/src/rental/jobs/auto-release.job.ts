import { Inject, Injectable } from '@nestjs/common';
import { SchedulerRegistry } from '@nestjs/schedule';
import { InjectDataSource, InjectRepository } from '@nestjs/typeorm';
import { DataSource, LessThanOrEqual, Repository } from 'typeorm';
import { OutboxService } from '../../messaging/outbox.service';
import { Deposit } from '../entities/deposit.entity';
import type { DepositReleasedPayload } from '../services/deposit-lifecycle.service';
import { ListingSyncService } from '../services/listing-sync.service';
import { IntervalJob } from './interval-job';

export interface AutoReleaseConfig {
  /** `AUTO_RELEASE_INTERVAL_MS`; `0` tắt (test gọi `runOnce`). */
  intervalMs: number;
}
export const AUTO_RELEASE_CONFIG = Symbol('AUTO_RELEASE_CONFIG');

export interface AutoReleaseResult {
  released: number;
  /** `UPDATE` 0 dòng: người thuê vừa yêu cầu hoàn hoặc nhận phòng (E7). */
  skipped: number;
  failed: number;
}

const JOB_NAME = 'auto-release';
const BATCH = 50;

/**
 * `AutoReleaseJob` — tự giải ngân sau 72 giờ (BR-13, `RE.DEPOSIT_LIFECYCLE/Component_Class_Design.md §4`). Mỗi
 * `AUTO_RELEASE_INTERVAL_MS`, tối đa 50 đơn `PAID` đã tới `auto_release_at` (`ix_deposits_auto_release`): một
 * transaction `UPDATE ... WHERE status='PAID' AND auto_release_at <= now()` → `RELEASED` trigger `AUTO`, đích listing
 * `RENTED` + outbox `rental.deposit-released`; sau commit đẩy `RENTED` (lỗi → `SagaReconcileJob` (b)).
 *
 * `REFUND_REQUESTED` tự bị loại. Đua với yêu cầu hoàn: cả hai `UPDATE ... WHERE status='PAID'`, bên 0 dòng thua → một
 * trạng thái cuối (E7). Truy vấn: 1 `SELECT`/lượt; mỗi đơn 2 + 1 (đánh dấu đã đẩy).
 */
@Injectable()
export class AutoReleaseJob extends IntervalJob {
  constructor(
    @InjectRepository(Deposit) private readonly deposits: Repository<Deposit>,
    @InjectDataSource() private readonly dataSource: DataSource,
    @Inject(OutboxService) private readonly outbox: OutboxService,
    @Inject(ListingSyncService) private readonly sync: ListingSyncService,
    @Inject(SchedulerRegistry) scheduler: SchedulerRegistry,
    @Inject(AUTO_RELEASE_CONFIG) config: AutoReleaseConfig,
  ) {
    super(scheduler, JOB_NAME, config.intervalMs);
  }

  async runOnce(): Promise<AutoReleaseResult> {
    const r: AutoReleaseResult = { released: 0, skipped: 0, failed: 0 };
    const now = new Date();
    const due = await this.deposits.find({
      where: { status: 'PAID', autoReleaseAt: LessThanOrEqual(now) },
      order: { autoReleaseAt: 'ASC' },
      take: BATCH,
    });

    for (const d of due) {
      let released: boolean;
      try {
        released = await this.dataSource.transaction(async (m) => {
          const { affected } = await m.update(
            Deposit,
            { id: d.id, status: 'PAID', autoReleaseAt: LessThanOrEqual(now) },
            {
              status: 'RELEASED',
              releasedAt: now,
              releaseTrigger: 'AUTO',
              listingTargetStatus: 'RENTED',
              listingSyncedAt: null,
            },
          );
          if (!affected) return false;
          await this.outbox.add<DepositReleasedPayload>(m, 'rental.deposit-released', {
            depositId: d.id,
            listingId: d.listingId,
            tenantId: d.tenantId,
            ownerId: d.ownerId,
            trigger: 'AUTO',
          });
          return true;
        });
      } catch (err) {
        r.failed++;
        this.logger.warn(
          `Tự giải ngân đơn ${d.id} lỗi, lượt sau thử lại: ${(err as Error).message}`,
        );
        continue;
      }
      if (!released) {
        r.skipped++;
        continue;
      }
      r.released++;
      try {
        await this.sync.push({ id: d.id, listingId: d.listingId, listingTargetStatus: 'RENTED' });
      } catch (err) {
        this.logger.warn(`Chưa đẩy được RENTED cho đơn ${d.id}: ${(err as Error).message}`);
      }
    }
    return r;
  }
}
