import { DataSource } from 'typeorm';
import { SEED_LISTINGS } from './seed-listings.data';

export interface SeedListingsResult {
  /** Số tin vừa tạo mới. */
  created: number;
  /** Số tin đã có sẵn (cùng id): giữ nguyên, không ghi đè. */
  existing: number;
}

/**
 * Nạp 30 tin seed (`SEED_LISTINGS`) vào `listings`.
 *
 * Chạy lại an toàn: trong MỘT transaction, mỗi tin `INSERT ... ON CONFLICT (id) DO NOTHING`. Tin đã có
 * (cùng id) giữ nguyên, kể cả khi đã bị sửa, giữ chỗ, đổi trạng thái sau khi seed (đang demo hay chạy
 * thử saga), nên seed không bao giờ phá dữ liệu đang dùng. Muốn về dữ liệu gốc thì reset DB dev
 * (`RE_Docker_Local_Guide.md §7`).
 *
 * Không đọc hay ghi `identity_db`: `owner_id` chỉ là UUID của chủ trọ seed (không có khóa ngoại, ADR-0005).
 * `created_at` lệch nhau 1 giờ theo thứ tự (tin số 1 mới nhất) để `sort=newest` ổn định và có thứ tự đoán được.
 * `reviewed_by` để `NULL`: id ADMIN không cố định (tạo bằng `seed:admin`).
 *
 * v1.5 (T2.6): dữ liệu seed giữ TÊN tỉnh, quận; `city_id`, `district_id` tra từ danh mục `RE.LOCATION`
 * bằng truy vấn con (id danh mục khác nhau giữa các môi trường). Tên không có trong danh mục → `NOT NULL`
 * lỗi, cả transaction hoàn tác.
 */
export async function seedListings(dataSource: DataSource): Promise<SeedListingsResult> {
  return dataSource.transaction(async (manager) => {
    let created = 0;
    let existing = 0;

    for (const [index, l] of SEED_LISTINGS.entries()) {
      const reviewed = l.approvalStatus !== 'PENDING_REVIEW';
      const inserted: Array<{ id: string }> = await manager.query(
        `INSERT INTO listings
           (id, owner_id, title, description, property_type, price_vnd, deposit_amount_vnd, area_m2,
            address, city_id, district_id, location, amenities, status, approval_status, reject_reason,
            reviewed_at, created_at, updated_at)
         VALUES
           ($1, $2, $3, $4, $5, $6, $7, $8, $9,
            (SELECT id FROM cities WHERE name = $11),
            (SELECT d.id FROM districts d JOIN cities c ON c.id = d.city_id
              WHERE c.name = $11 AND d.name = $10),
            ST_SetSRID(ST_MakePoint($13, $12), 4326)::geography,
            $14::text[], $15, $16, $17,
            CASE WHEN $18::boolean THEN now() END,
            now() - make_interval(hours => $19::int), now() - make_interval(hours => $19::int))
         ON CONFLICT (id) DO NOTHING
         RETURNING id`,
        [
          l.id,
          l.ownerId,
          l.title,
          l.description,
          l.propertyType,
          l.priceVnd,
          l.depositAmountVnd,
          l.areaM2,
          l.address,
          l.district,
          l.city,
          l.lat,
          l.lng,
          l.amenities,
          l.status,
          l.approvalStatus,
          l.rejectReason ?? null,
          reviewed,
          index,
        ],
      );
      if (inserted.length === 0) existing += 1;
      else created += 1;
    }

    return { created, existing };
  });
}
