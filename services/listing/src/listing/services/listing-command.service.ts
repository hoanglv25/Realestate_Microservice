import { Injectable } from '@nestjs/common';
import { DataSource, EntityManager } from 'typeorm';
import { AppException } from '../../common/errors/app.exception';
import { ErrorCode } from '../../common/errors/error-codes';
import { CreateListingDto } from '../dto/create-listing.dto';
import { ListingDto } from '../dto/listing.dto';
import { UpdateListingDto } from '../dto/update-listing.dto';
import {
  listingHasActiveDeposit,
  listingInvalidStatus,
  listingNotFound,
  listingNotOwner,
} from '../errors/listing.errors';
import { classifyEdit, EditableFields, resubmits } from './listing-edit.rules';
import { ListingPresenter } from './listing.presenter';
import { listingColumns, ListingRow, pointSql, rowsOf } from './listing.sql';
import { LocationQueryService } from './location-query.service';

/** Trường sửa được → cột DB (tên cột cố định ở đây, không lấy từ input). `lat`, `lng` đi qua `location`. */
const COLUMN_OF: Record<string, string> = {
  title: 'title',
  description: 'description',
  propertyType: 'property_type',
  priceVnd: 'price_vnd',
  depositAmountVnd: 'deposit_amount_vnd',
  areaM2: 'area_m2',
  address: 'address',
  cityId: 'city_id',
  districtId: 'district_id',
  amenities: 'amenities',
};

const toEditable = (row: ListingRow): EditableFields => ({
  title: row.title,
  description: row.description,
  propertyType: row.propertyType,
  priceVnd: row.priceVnd,
  depositAmountVnd: row.depositAmountVnd,
  areaM2: row.areaM2,
  address: row.address,
  cityId: row.cityId,
  districtId: row.districtId,
  amenities: row.amenities,
  lat: row.lat,
  lng: row.lng,
});

/** `400 VALIDATION_FAILED` khi quận không thuộc tỉnh (`RE.LISTING/API_Spec.md §1.2` mục 2a, không thêm mã lỗi). */
const districtNotInCity = () =>
  new AppException(ErrorCode.VALIDATION_FAILED, 'Dữ liệu không hợp lệ', 400, [
    { field: 'districtId', errors: ['Quận/huyện không thuộc tỉnh/thành đã chọn'] },
  ]);

/**
 * Thêm, sửa, ẩn, hiện, xóa mềm sản phẩm của chủ trọ (`RE.LISTING/API_Spec.md §1`, route 1–5).
 *
 * Mọi thay đổi trạng thái là MỘT câu `UPDATE ... WHERE <trạng thái mong đợi>`; 0 dòng thì đọc lại để
 * chọn `404` / `403` / `409` (`Processing_Flow.md §4`). Không có cửa sổ giữa kiểm tra và ghi, nên hide
 * không thể đè lên giữ chỗ của rental (cùng điều kiện `status = 'AVAILABLE'`, BR-06).
 * Chủ sở hữu luôn là `sub` trong JWT, không bao giờ từ body (BR-03).
 */
@Injectable()
export class ListingCommandService {
  constructor(
    private readonly dataSource: DataSource,
    private readonly presenter: ListingPresenter,
    private readonly locations: LocationQueryService,
  ) {}

  /** Route 1. `PENDING_REVIEW` + `AVAILABLE`: chưa hiện ở tìm kiếm cho tới khi quản trị viên duyệt. */
  async create(ownerId: string, dto: CreateListingDto): Promise<ListingDto> {
    if (!(await this.locations.isDistrictInCity(dto.cityId, dto.districtId))) {
      throw districtNotInCity();
    }
    const [row] = await this.dataSource.query<ListingRow[]>(
      `INSERT INTO listings AS l
         (owner_id, title, description, property_type, price_vnd, deposit_amount_vnd, area_m2,
          address, city_id, district_id, amenities, location)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::text[], ${pointSql('$13', '$12')})
       RETURNING ${listingColumns('l')}`,
      [
        ownerId,
        dto.title,
        dto.description ?? null,
        dto.propertyType,
        dto.priceVnd,
        dto.depositAmountVnd,
        dto.areaM2,
        dto.address,
        dto.cityId,
        dto.districtId,
        dto.amenities ?? [],
        dto.lat,
        dto.lng,
      ],
    );
    return (await this.presenter.present([row]))[0];
  }

  /**
   * Route 2. Đọc dòng bằng `FOR UPDATE` trong transaction ngắn: trong lúc sửa, quản trị viên không duyệt
   * chen vào được, nên quyết định "về `PENDING_REVIEW` hay giữ nguyên" luôn dựa trên trạng thái duyệt
   * hiện tại (`listing-edit.rules.ts`, bảng ở `API_Spec.md §1.1`).
   */
  async update(ownerId: string, id: string, dto: UpdateListingDto): Promise<ListingDto> {
    const patch = Object.fromEntries(
      Object.entries(dto).filter(([, v]) => v !== undefined),
    ) as Partial<EditableFields>;
    if (Object.keys(patch).length === 0) {
      throw new AppException(ErrorCode.VALIDATION_FAILED, 'Dữ liệu không hợp lệ', 400, [
        { field: 'body', errors: ['Cần ít nhất một trường để sửa'] },
      ]);
    }

    const row = await this.dataSource.transaction(async (manager) => {
      const current = await this.lockOwned(manager, id, ownerId);
      // Mục 2a §1.2: sau 404/403. DTO bảo đảm hai trường đi cùng nhau
      if (
        patch.cityId !== undefined &&
        patch.districtId !== undefined &&
        !(await this.locations.isDistrictInCity(patch.cityId, patch.districtId))
      ) {
        throw districtNotInCity();
      }
      const edit = classifyEdit(toEditable(current), patch);
      if (edit.changed.length === 0) return current; // gửi lại đúng giá trị cũ: không ghi gì

      const params: unknown[] = [id];
      const sets: string[] = [];
      for (const field of edit.changed) {
        const column = COLUMN_OF[field];
        if (!column) continue; // lat, lng xử lý ở dưới
        params.push(patch[field as keyof EditableFields]);
        sets.push(`${column} = $${params.length}${field === 'amenities' ? '::text[]' : ''}`);
      }
      if (edit.changed.includes('lat') || edit.changed.includes('lng')) {
        params.push(patch.lng ?? current.lng, patch.lat ?? current.lat);
        sets.push(`location = ${pointSql(`$${params.length - 1}`, `$${params.length}`)}`);
      }
      if (resubmits(current.approvalStatus, edit)) {
        sets.push(
          `approval_status = 'PENDING_REVIEW'`,
          'reject_reason = NULL',
          'reviewed_by = NULL',
          'reviewed_at = NULL',
        );
      }
      sets.push('version = version + 1', 'updated_at = now()');

      const [updated] = rowsOf<ListingRow>(
        await manager.query(
          `UPDATE listings AS l SET ${sets.join(', ')} WHERE l.id = $1 RETURNING ${listingColumns('l')}`,
          params,
        ),
      );
      return updated;
    });
    return (await this.presenter.present([row]))[0];
  }

  /** Route 3: `AVAILABLE → HIDDEN`. Tin đang `HELD`, `DEPOSITED`, `RENTED` hoặc đã ẩn → `409 LISTING_INVALID_STATUS`. */
  hide(ownerId: string, id: string): Promise<ListingDto> {
    return this.transition(ownerId, id, 'AVAILABLE', 'HIDDEN');
  }

  /** Route 4: `HIDDEN → AVAILABLE`. */
  unhide(ownerId: string, id: string): Promise<ListingDto> {
    return this.transition(ownerId, id, 'HIDDEN', 'AVAILABLE');
  }

  /**
   * Route 5: xóa mềm bằng một câu `UPDATE` (`Processing_Flow.md §4`). Tin `HELD` hoặc `DEPOSITED`
   * (đang có đơn đặt cọc) không xóa được (BR-03, Báo cáo T18).
   */
  async softDelete(ownerId: string, id: string): Promise<void> {
    const deleted = rowsOf<{ id: string }>(
      await this.dataSource.query(
        `UPDATE listings
            SET deleted_at = now(), updated_at = now(), version = version + 1
          WHERE id = $1 AND owner_id = $2 AND status NOT IN ('HELD', 'DEPOSITED') AND deleted_at IS NULL
          RETURNING id`,
        [id, ownerId],
      ),
    );
    if (deleted.length > 0) return;

    const current = await this.findOwned(id, ownerId);
    // Còn tồn tại và là của mình: chỉ có thể vì đang HELD/DEPOSITED (hoặc vừa đổi trạng thái ở giữa)
    throw current.status === 'HELD' || current.status === 'DEPOSITED'
      ? listingHasActiveDeposit()
      : listingInvalidStatus();
  }

  private async transition(
    ownerId: string,
    id: string,
    from: 'AVAILABLE' | 'HIDDEN',
    to: 'AVAILABLE' | 'HIDDEN',
  ): Promise<ListingDto> {
    const [row] = rowsOf<ListingRow>(
      await this.dataSource.query(
        `UPDATE listings AS l
            SET status = $3, version = version + 1, updated_at = now()
          WHERE l.id = $1 AND l.owner_id = $2 AND l.status = $4 AND l.deleted_at IS NULL
          RETURNING ${listingColumns('l')}`,
        [id, ownerId, to, from],
      ),
    );
    if (row) return (await this.presenter.present([row]))[0];

    await this.findOwned(id, ownerId); // 404 hoặc 403
    throw listingInvalidStatus();
  }

  /** Đọc tin chưa xóa: không có → 404, không phải của người gọi → 403 (thứ tự `API_Spec.md §1.2`). */
  private async findOwned(id: string, ownerId: string): Promise<{ status: string }> {
    const [row] = await this.dataSource.query<Array<{ ownerId: string; status: string }>>(
      `SELECT owner_id AS "ownerId", status FROM listings WHERE id = $1 AND deleted_at IS NULL`,
      [id],
    );
    if (!row) throw listingNotFound();
    if (row.ownerId !== ownerId) throw listingNotOwner();
    return row;
  }

  /** Đọc tin và khóa dòng (`FOR UPDATE`) trong transaction của người gọi. */
  private async lockOwned(
    manager: EntityManager,
    id: string,
    ownerId: string,
  ): Promise<ListingRow & { approvalStatus: ListingRow['approvalStatus'] }> {
    const [row] = await manager.query<ListingRow[]>(
      `SELECT ${listingColumns('l')} FROM listings l
        WHERE l.id = $1 AND l.deleted_at IS NULL FOR UPDATE OF l`,
      [id],
    );
    if (!row) throw listingNotFound();
    if (row.ownerId !== ownerId) throw listingNotOwner();
    return row;
  }
}
