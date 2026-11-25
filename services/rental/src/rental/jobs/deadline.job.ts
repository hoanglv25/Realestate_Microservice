import { Inject, Injectable } from '@nestjs/common';
import { SchedulerRegistry } from '@nestjs/schedule';
import { InjectDataSource, InjectRepository } from '@nestjs/typeorm';
import { And, DataSource, IsNull, LessThanOrEqual, MoreThan, Repository } from 'typeorm';
import { OutboxService } from '../../messaging/outbox.service';
import { Deposit } from '../entities/deposit.entity';
import { IntervalJob } from './interval-job';

export interface DeadlineConfig {
  /** `DEADLINE_INTERVAL_MS`; `0` tắt (test gọi `runOnce`). */
  intervalMs: number;
  /** `RELEASE_REMINDER_SECONDS` (24 giờ). */
  reminderSeconds: number;
}
export const DEADLINE_CONFIG = Symbol('DEADLINE_CONFIG');

/** Payload `rental.release-reminder.v1`. */
export interface ReleaseReminderPayload {
  depositId: string;
  listingId: string;
  tenantId: string;
  ownerId: string;
  autoReleaseAt: string;
}

export interface DeadlineResult {
  reminded: number;
  skipped: number;
  failed: number;
}

const JOB_NAME = 'deadline';
const BATCH = 50;

/**
 * `DeadlineJob` — nhắc trước khi tự giải ngân (BR-13, chốt T3.5 B6, `Component_Class_Design §4a`). Mỗi
 * `DEADLINE_INTERVAL_MS`, tối đa 50 đơn `PAID` chưa nhắc có `now < auto_release_at <= now + RELEASE_REMINDER_SECONDS`:
 * transaction `UPDATE release_reminded_at = now() WHERE ... release_reminded_at IS NULL` + outbox
 * `rental.release-reminder` → đúng một sự kiện mỗi đơn (test 15). Truy vấn: 1 `SELECT`/lượt; mỗi đơn 2.
 */
@Injectable()
export class DeadlineJob extends IntervalJob {
  constructor(
    @InjectRepository(Deposit) private readonly deposits: Repository<Deposit>,
    @InjectDataSource() private readonly dataSource: DataSource,
    @Inject(OutboxService) private readonly outbox: OutboxService,
    @Inject(SchedulerRegistry) scheduler: SchedulerRegistry,
    @Inject(DEADLINE_CONFIG) private readonly config: DeadlineConfig,
  ) {
    super(scheduler, JOB_NAME, config.intervalMs);
  }

  async runOnce(): Promise<DeadlineResult> {
    const r: DeadlineResult = { reminded: 0, skipped: 0, failed: 0 };
    const now = new Date();
    const horizon = new Date(now.getTime() + this.config.reminderSeconds * 1000);
    const due = await this.deposits.find({
      where: {
        status: 'PAID',
        releaseRemindedAt: IsNull(),
        autoReleaseAt: And(MoreThan(now), LessThanOrEqual(horizon)),
      },
      order: { autoReleaseAt: 'ASC' },
      take: BATCH,
    });

    for (const d of due) {
      try {
        const reminded = await this.dataSource.transaction(async (m) => {
          const { affected } = await m.update(
            Deposit,
            { id: d.id, status: 'PAID', releaseRemindedAt: IsNull() },
            { releaseRemindedAt: now },
          );
          if (!affected) return false;
          await this.outbox.add<ReleaseReminderPayload>(m, 'rental.release-reminder', {
            depositId: d.id,
            listingId: d.listingId,
            tenantId: d.tenantId,
            ownerId: d.ownerId,
            autoReleaseAt: (d.autoReleaseAt as Date).toISOString(),
          });
          return true;
        });
        if (reminded) r.reminded++;
        else r.skipped++;
      } catch (err) {
        r.failed++;
        this.logger.warn(
          `Nhắc giải ngân đơn ${d.id} lỗi, lượt sau thử lại: ${(err as Error).message}`,
        );
      }
    }
    return r;
  }
}
