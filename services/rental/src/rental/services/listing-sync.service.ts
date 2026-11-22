import { Inject, Injectable, Logger } from '@nestjs/common';
import { InjectDataSource, InjectRepository } from '@nestjs/typeorm';
import { DataSource, IsNull, Repository } from 'typeorm';
import { classifyCall } from '../clients/call-outcome';
import { ListingClient } from '../clients/listing.client';
import type { ListingTargetStatus } from '../clients/listing.client';
import { Deposit } from '../entities/deposit.entity';
import { SagaLog } from '../entities/saga-log.entity';
import { errorDetail, sagaLogRow } from './saga-log';

/** Phần của đơn cần để đẩy trạng thái tin. */
export type SyncTarget = Pick<Deposit, 'id' | 'listingId'> & {
  listingTargetStatus: ListingTargetStatus | null;
};

/** `SYNCED` đã đẩy; `REJECTED` listing từ chối (kết cục cuối, C20); `RETRY` lỗi tạm, job đẩy lại; `SKIPPED` không có đích. */
export type SyncResult = 'SYNCED' | 'REJECTED' | 'RETRY' | 'SKIPPED';

/**
 * Đẩy `deposits.listing_target_status` sang listing bằng `PUT /internal/listings/:id/status` (idempotent, có
 * retry trong `InternalHttpService`) — `RE.DEPOSIT_SAGA/Component_Class_Design.md §5, §7` (job (b)).
 *
 * - Thành công: đặt `listing_synced_at` **chỉ khi** đích chưa đổi và chưa đánh dấu (A duyệt B7, 2026-11-22): đích
 *   vừa đổi giữa lúc đẩy (ví dụ `PAID` → `DEPOSITED`) thì lượt sau đẩy đích mới. 1 truy vấn, không `saga_log` (B2).
 * - Listing trả 4xx (`409 LISTING_INVALID_STATUS`: tin đã thuộc đơn khác, C20; `404`, `400`): **kết cục cuối**,
 *   đánh dấu đã đồng bộ + `saga_log SYNC_LISTING BUSINESS_ERROR` kèm `details`, cùng transaction; log `warn`.
 * - `503`/`504`/lỗi kết nối/lỗi lạ: không đánh dấu, chỉ log `warn` (không ghi `saga_log` mỗi lượt, B2).
 *
 * Không transaction nào bao lời gọi HTTP.
 */
@Injectable()
export class ListingSyncService {
  private readonly logger = new Logger(ListingSyncService.name);

  constructor(
    @Inject(ListingClient) private readonly listing: ListingClient,
    @InjectRepository(Deposit) private readonly deposits: Repository<Deposit>,
    @InjectDataSource() private readonly dataSource: DataSource,
  ) {}

  async push(d: SyncTarget): Promise<SyncResult> {
    const target = d.listingTargetStatus;
    if (!target) return 'SKIPPED';
    const unsynced = { id: d.id, listingTargetStatus: target, listingSyncedAt: IsNull() };
    try {
      await this.listing.changeStatus(d.listingId, d.id, target);
    } catch (err) {
      if (classifyCall(err) !== 'BUSINESS_ERROR') {
        this.logger.warn(
          `Chưa đẩy được ${target} cho tin ${d.listingId} (đơn ${d.id}), lượt job sau đẩy lại: ${JSON.stringify(errorDetail(err))}`,
        );
        return 'RETRY';
      }
      const detail = errorDetail(err, true);
      await this.dataSource.transaction(async (m) => {
        await m.update(Deposit, unsynced, { listingSyncedAt: () => 'now()' });
        await m.insert(SagaLog, sagaLogRow(d.id, 'SYNC_LISTING', 'BUSINESS_ERROR', detail));
      });
      this.logger.warn(
        `Listing từ chối ${target} cho tin ${d.listingId} (đơn ${d.id}), dừng đẩy (C20): ${JSON.stringify(detail)}`,
      );
      return 'REJECTED';
    }
    await this.deposits.update(unsynced, { listingSyncedAt: () => 'now()' });
    return 'SYNCED';
  }
}
