import { ApprovalStatus, ListingStatus, PropertyType } from '../entities/listing.enums';

/**
 * Một dòng `listings` đọc bằng SQL thuần (có `lat`, `lng` tách từ `location`). Tên cột đã đổi sang
 * camelCase ở `listingColumns`, `ListingPresenter` đổi dòng này thành `ListingDto`.
 */
export interface ListingRow {
  id: string;
  ownerId: string;
  title: string;
  description: string | null;
  propertyType: PropertyType;
  priceVnd: number;
  depositAmountVnd: number;
  areaM2: number;
  address: string | null;
  cityId: string;
  city: string;
  districtId: string;
  district: string;
  amenities: string[];
  lat: number;
  lng: number;
  status: ListingStatus;
  approvalStatus: ApprovalStatus;
  rejectReason: string | null;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * Cột địa giới của tin (`RE.LISTING` v1.5): id và tên tỉnh, quận. Tên lấy bằng truy vấn con theo PK của
 * `cities`, `districts` nên dùng được cả trong `SELECT` lẫn `INSERT/UPDATE ... RETURNING` và không thêm
 * lượt truy vấn. Cột `NOT NULL` + FK nên tên luôn có.
 */
export const locationColumns = (alias: string): string =>
  `${alias}.city_id AS "cityId", ` +
  `(SELECT c.name FROM cities c WHERE c.id = ${alias}.city_id) AS city, ` +
  `${alias}.district_id AS "districtId", ` +
  `(SELECT d.name FROM districts d WHERE d.id = ${alias}.district_id) AS district`;

/**
 * Danh sách cột của `ListingRow`, dùng cho `SELECT` và `RETURNING` (`alias` là bí danh bảng `listings`).
 * `bigint`, `numeric` ép về `float8` để pg trả number (tiền VND < 2^53, `database/transformers.ts`).
 * `location` là `geography`: `::geometry` rồi `ST_Y` (vĩ độ), `ST_X` (kinh độ).
 */
export const listingColumns = (alias: string): string => `
  ${alias}.id,
  ${alias}.owner_id AS "ownerId",
  ${alias}.title,
  ${alias}.description,
  ${alias}.property_type AS "propertyType",
  ${alias}.price_vnd::float8 AS "priceVnd",
  ${alias}.deposit_amount_vnd::float8 AS "depositAmountVnd",
  ${alias}.area_m2::float8 AS "areaM2",
  ${alias}.address,
  ${locationColumns(alias)},
  ${alias}.amenities,
  ST_Y(${alias}.location::geometry) AS lat,
  ST_X(${alias}.location::geometry) AS lng,
  ${alias}.status,
  ${alias}.approval_status AS "approvalStatus",
  ${alias}.reject_reason AS "rejectReason",
  ${alias}.created_at AS "createdAt",
  ${alias}.updated_at AS "updatedAt"`;

/** Biểu thức `geography` từ kinh độ, vĩ độ (tham số SQL `$lng`, `$lat`). Thứ tự `ST_MakePoint` là (lng, lat). */
export const pointSql = (lngParam: string, latParam: string): string =>
  `ST_SetSRID(ST_MakePoint(${lngParam}, ${latParam}), 4326)::geography`;

/**
 * Lấy mảng dòng từ kết quả `query()` của TypeORM + Postgres. `SELECT` và `INSERT ... RETURNING` trả
 * thẳng mảng dòng, còn `UPDATE`/`DELETE ... RETURNING` trả `[dòng, số dòng bị ảnh hưởng]`.
 * Mọi `UPDATE ... RETURNING` ở listing phải bọc bằng hàm này.
 */
export function rowsOf<T>(result: unknown): T[] {
  if (
    Array.isArray(result) &&
    result.length === 2 &&
    Array.isArray(result[0]) &&
    typeof result[1] === 'number'
  ) {
    return result[0] as T[];
  }
  return result as T[];
}

/** Mã lỗi Postgres khi vi phạm ràng buộc duy nhất. */
export const PG_UNIQUE_VIOLATION = '23505';

/** Lỗi `QueryFailedError` của TypeORM bọc lỗi pg ở `driverError`. */
export function isUniqueViolation(err: unknown): boolean {
  const code =
    (err as { driverError?: { code?: string }; code?: string } | null)?.driverError?.code ??
    (err as { code?: string } | null)?.code;
  return code === PG_UNIQUE_VIOLATION;
}
