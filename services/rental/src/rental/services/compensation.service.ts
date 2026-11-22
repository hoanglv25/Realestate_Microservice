import { Inject, Injectable, Logger } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { OutboxService } from '../../messaging/outbox.service';
import { Deposit } from '../entities/deposit.entity';
import { SagaLog } from '../entities/saga-log.entity';
import type { SagaOutcome, SagaStep } from '../entities/saga-log.entity';
import { ListingSyncService } from './listing-sync.service';
import { sagaLogRow } from './saga-log';

/** `deposits.cancelled_reason` khi bù trừ (A duyệt B3, 2026-11-22). */
export type CancelReason =
  | 'PAYMENT_ORDER_REJECTED' // payment trả 4xx khi tạo order
  | 'PAYMENT_UNAVAILABLE' // không gửi được lệnh tạo order (NOT_EXECUTED)
  | 'PAYMENT_ORDER_NOT_FOUND'; // job (a): đơn kẹt, payment không có order

/** Nguyên nhân bù trừ, ghi vào `saga_log` cùng transaction. */
export interface CancelCause {
  step: SagaStep;
  outcome: Exclude<SagaOutcome, 'OK'>;
  detail: Record<string, unknown>;
  reason: CancelReason;
}

/** Payload `contracts/events/rental.deposit-cancelled.v1.schema.json`. */
export interface DepositCancelledPayload {
  depositId: string;
  listingId: string;
  tenantId: string;
  ownerId: string;
}

/**
 * Bù trừ sau khi đã giữ chỗ và tạo đơn (`RE.DEPOSIT_SAGA/Component_Class_Design.md §5`, `Processing_Flow §3`).
 *
 * 1. Transaction: `UPDATE deposits SET status='CANCELLED', cancelled_reason, listing_target_status='AVAILABLE'
 *    WHERE id AND status='PENDING_PAYMENT'`; 0 dòng → dừng (bên khác đã xử lý: `PAID`, `EXPIRED`, đã hủy).
 *    `saga_log` nguyên nhân, outbox `rental.deposit-cancelled`. 3 truy vấn.
 * 2. Sau commit: đẩy `AVAILABLE` sang listing (`ListingSyncService.push`); lỗi thì job (b) đẩy lại.
 *
 * Không gọi hủy order: chỉ bù trừ khi chắc chắn payment chưa có order (tạo order `BUSINESS_ERROR`/`NOT_EXECUTED`,
 * hoặc job (a) thấy `404`). Không transaction nào bao lời gọi HTTP.
 */
@Injectable()
export class CompensationService {
  private readonly logger = new Logger(CompensationService.name);

  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    @Inject(OutboxService) private readonly outbox: OutboxService,
    @Inject(ListingSyncService) private readonly sync: ListingSyncService,
  ) {}

  /** `true` khi đơn vừa được chuyển sang `CANCELLED`; `false` khi đơn đã không còn `PENDING_PAYMENT`. */
  async cancelAfterHold(
    d: Pick<Deposit, 'id' | 'listingId' | 'tenantId' | 'ownerId'>,
    cause: CancelCause,
  ): Promise<boolean> {
    const cancelled = await this.dataSource.transaction(async (m) => {
      const { affected } = await m.update(
        Deposit,
        { id: d.id, status: 'PENDING_PAYMENT' },
        {
          status: 'CANCELLED',
          cancelledReason: cause.reason,
          listingTargetStatus: 'AVAILABLE',
          listingSyncedAt: null,
        },
      );
      if (!affected) return false;
      await m.insert(SagaLog, sagaLogRow(d.id, cause.step, cause.outcome, cause.detail));
      await this.outbox.add<DepositCancelledPayload>(m, 'rental.deposit-cancelled', {
        depositId: d.id,
        listingId: d.listingId,
        tenantId: d.tenantId,
        ownerId: d.ownerId,
      });
      return true;
    });
    if (!cancelled) return false;

    try {
      await this.sync.push({ id: d.id, listingId: d.listingId, listingTargetStatus: 'AVAILABLE' });
    } catch (err) {
      // Đơn đã CANCELLED; đích AVAILABLE nằm trong DB, job (b) đẩy lại
      this.logger.warn(
        `Chưa đẩy được AVAILABLE cho đơn ${d.id} sau bù trừ: ${(err as Error).message}`,
      );
    }
    return true;
  }
}
