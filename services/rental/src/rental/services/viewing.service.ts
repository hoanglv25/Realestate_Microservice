import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, EntityManager, Repository } from 'typeorm';
import type { AuthUser } from '../../common/auth/authenticated-user';

/** Phần của JWT mà danh sách cần. */
type Caller = Pick<AuthUser, 'sub' | 'roles'>;
import { Paginated } from '../../common/response/response-meta';
import { OutboxService } from '../../messaging/outbox.service';
import { ListingClient } from '../clients/listing.client';
import { CreateViewingDto, ListViewingsQuery, ViewingDto } from '../dto/viewing.dto';
import { Viewing } from '../entities/viewing.entity';
import type { ViewingCancelReason, ViewingStatus } from '../entities/viewing.entity';
import {
  invalidTransition,
  isUniqueViolation,
  listingNotFound,
  notRelated,
  viewingDuplicate,
  viewingNotFound,
  viewingOwnListing,
} from '../errors/rental.errors';

/** Dòng `viewings` đọc bằng SQL thô (`RETURNING *`). */
interface ViewingRow {
  id: string;
  listing_id: string;
  tenant_id: string;
  owner_id: string;
  listing_title: string;
  status: ViewingStatus;
  cancel_reason: ViewingCancelReason | null;
  note: string | null;
  created_at: Date;
}

const toDto = (r: ViewingRow): ViewingDto => ({
  id: r.id,
  listingId: r.listing_id,
  listingTitle: r.listing_title,
  tenantId: r.tenant_id,
  ownerId: r.owner_id,
  status: r.status,
  cancelReason: r.cancel_reason,
  note: r.note,
  createdAt: new Date(r.created_at).toISOString(),
});

/** Payload chung của 4 sự kiện `rental.viewing-*` (`contracts/events`). */
const basePayload = (r: ViewingRow) => ({
  viewingId: r.id,
  listingId: r.listing_id,
  tenantId: r.tenant_id,
  ownerId: r.owner_id,
});

/** TypeORM + pg trả `[rows, rowCount]` cho UPDATE ... RETURNING. */
const updatedRows = (result: unknown): ViewingRow[] =>
  (Array.isArray(result) && Array.isArray(result[0]) ? result[0] : []) as ViewingRow[];

/** Ai được làm thao tác (route 2: chủ tin; route 3, 5: người đặt). */
type Actor = { column: 'owner_id' | 'tenant_id'; userId: string };

const UNIQUE_OPEN = 'ux_viewings_open_per_tenant';

/**
 * Lịch xem nhà (`RE.VIEWING`). Người thuê bấm "Đặt lịch xem" (không chọn giờ), chủ trọ chỉ có thể từ chối,
 * người thuê tự xác nhận đã xem hoặc tự hủy. Mỗi chuyển trạng thái: một transaction gồm
 * `UPDATE ... WHERE id AND status='REQUESTED' AND <người liên quan>` + `outbox.add`; 0 dòng → đọc lại để chọn
 * 404 / 403 / 409 (`Component_Class_Design.md §2`). Truy vấn: 2 (UPDATE, outbox), +1 SELECT khi 0 dòng.
 */
@Injectable()
export class ViewingService {
  constructor(
    private readonly dataSource: DataSource,
    @InjectRepository(Viewing) private readonly viewings: Repository<Viewing>,
    private readonly listing: ListingClient,
    private readonly outbox: OutboxService,
  ) {}

  /** Route 1. Kiểm theo thứ tự `API_Spec §1`: bản chụp (404, chưa duyệt) → chủ tin (403) → trùng (409). */
  async request(tenantId: string, dto: CreateViewingDto): Promise<ViewingDto> {
    const snap = await this.listing.getSnapshot(dto.listingId); // 404 chuyển nguyên; 503/504
    if (snap.approvalStatus !== 'APPROVED') throw listingNotFound();
    if (snap.ownerId === tenantId) throw viewingOwnListing();

    try {
      return await this.dataSource.transaction(async (m) => {
        const [r] = (await m.query(
          `INSERT INTO viewings (listing_id, tenant_id, owner_id, listing_title, note)
           VALUES ($1, $2, $3, $4, $5) RETURNING *`,
          [dto.listingId, tenantId, snap.ownerId, snap.title, dto.note ?? null],
        )) as ViewingRow[];
        await this.outbox.add(m, 'rental.viewing-requested', basePayload(r));
        return toDto(r);
      });
    } catch (err) {
      if (isUniqueViolation(err, UNIQUE_OPEN)) throw viewingDuplicate();
      throw err;
    }
  }

  /** Route 2: chủ tin từ chối (`decision = DECLINE`). Ghi chú của chủ trọ chưa có cột để lưu. */
  decline(ownerId: string, id: string): Promise<ViewingDto> {
    return this.transition(
      id,
      { column: 'owner_id', userId: ownerId },
      `status = 'DECLINED', declined_at = now()`,
      (r) => ({
        type: 'rental.viewing-responded',
        payload: { ...basePayload(r), decision: 'DECLINED' },
      }),
    );
  }

  /** Route 3: người đặt xác nhận đã xem. */
  confirmViewed(tenantId: string, id: string): Promise<ViewingDto> {
    return this.transition(
      id,
      { column: 'tenant_id', userId: tenantId },
      `status = 'CONFIRMED', confirmed_at = now()`,
      (r) => ({ type: 'rental.viewing-confirmed', payload: basePayload(r) }),
    );
  }

  /** Route 5: người đặt tự hủy. */
  cancelByTenant(tenantId: string, id: string): Promise<ViewingDto> {
    return this.transition(
      id,
      { column: 'tenant_id', userId: tenantId },
      `status = 'CANCELLED', cancel_reason = 'TENANT', cancelled_at = now()`,
      (r) => ({
        type: 'rental.viewing-cancelled',
        payload: { ...basePayload(r), reason: 'TENANT' },
      }),
    );
  }

  /**
   * Chạy TRONG transaction của handler `payment.deposited` (dùng chung `m`, chốt 2026-11-16): hủy mọi yêu cầu
   * `REQUESTED` của NGƯỜI KHÁC trên tin, mỗi dòng một `rental.viewing-cancelled` (`LISTING_DEPOSITED`).
   * Yêu cầu của người cọc và yêu cầu đã `CONFIRMED` giữ nguyên. Không gọi HTTP.
   */
  async cancelOthersOnDeposit(
    m: EntityManager,
    listingId: string,
    depositTenantId: string,
  ): Promise<number> {
    const rows = updatedRows(
      await m.query(
        `UPDATE viewings
            SET status = 'CANCELLED', cancel_reason = 'LISTING_DEPOSITED', cancelled_at = now(), updated_at = now()
          WHERE listing_id = $1 AND status = 'REQUESTED' AND tenant_id <> $2
          RETURNING *`,
        [listingId, depositTenantId],
      ),
    );
    for (const r of rows) {
      await this.outbox.add(m, 'rental.viewing-cancelled', {
        ...basePayload(r),
        reason: 'LISTING_DEPOSITED',
      });
    }
    return rows.length;
  }

  /** Route 4: người thuê thấy yêu cầu mình gửi; chủ trọ thấy yêu cầu trên tin của mình. 2 truy vấn. */
  async findMine(user: Caller, query: ListViewingsQuery): Promise<Paginated<ViewingDto>> {
    const isOwner = user.roles.includes('LANDLORD');
    const [rows, total] = await this.viewings.findAndCount({
      where: {
        ...(isOwner ? { ownerId: user.sub } : { tenantId: user.sub }),
        ...(query.listingId ? { listingId: query.listingId } : {}),
        ...(query.status ? { status: query.status } : {}),
      },
      order: { createdAt: 'DESC', id: 'DESC' },
      skip: query.skip,
      take: query.pageSize,
    });
    return new Paginated(rows.map(ViewingDto.from), query.page, query.pageSize, total);
  }

  private async transition(
    id: string,
    actor: Actor,
    set: string,
    event: (r: ViewingRow) => { type: string; payload: Record<string, unknown> },
  ): Promise<ViewingDto> {
    return this.dataSource.transaction(async (m) => {
      const [r] = updatedRows(
        await m.query(
          `UPDATE viewings SET ${set}, updated_at = now()
            WHERE id = $1 AND ${actor.column} = $2 AND status = 'REQUESTED'
            RETURNING *`,
          [id, actor.userId],
        ),
      );
      if (!r) {
        const found = await m.findOneBy(Viewing, { id });
        if (!found) throw viewingNotFound();
        const related = actor.column === 'owner_id' ? found.ownerId : found.tenantId;
        if (related !== actor.userId) throw notRelated();
        throw invalidTransition();
      }
      const e = event(r);
      await this.outbox.add(m, e.type, e.payload);
      return toDto(r);
    });
  }
}
