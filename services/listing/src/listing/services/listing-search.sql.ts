import { SearchListingsQuery } from '../dto/search-listings.query';
import { ListingStatus, PropertyType } from '../entities/listing.enums';
import { locationColumns, pointSql } from './listing.sql';

/** Một dòng kết quả tìm kiếm (trước khi đổi thành `ListingSummaryDto`). */
export interface SearchRow {
  id: string;
  ownerId: string;
  title: string;
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
  createdAt: Date;
  /** `object_key` của ảnh bìa, `null` khi tin chưa có ảnh. */
  coverKey: string | null;
  /** Mét, làm tròn; chỉ có khi request có `lat` và `lng`. */
  distanceM?: number;
}

/** Hai câu truy vấn của một lần tìm kiếm cùng tham số riêng (count không được thừa tham số của data). */
export interface BuiltSearch {
  countSql: string;
  countParams: unknown[];
  dataSql: string;
  dataParams: unknown[];
}

/** Điều kiện nền của mọi lần tìm kiếm: tin đã duyệt, chưa xóa, không ẩn (`API_Spec.md §1.3`). */
const BASE_CONDITIONS = [
  `l.approval_status = 'APPROVED'`,
  'l.deleted_at IS NULL',
  `l.status <> 'HIDDEN'`,
];

/** Ảnh bìa = ảnh `sort_order` nhỏ nhất, rồi `created_at`, `id` (`API_Spec.md §1.4`). */
const COVER_JOIN = `LEFT JOIN LATERAL (SELECT i.object_key FROM listing_images i WHERE i.listing_id = l.id ORDER BY i.sort_order, i.created_at, i.id LIMIT 1) cover ON true`;

/** Cột của `ListingSummaryDto`: không có `description`, `approval_status`, `reject_reason`, `updated_at`. */
const SUMMARY_COLUMNS = `l.id, l.owner_id AS "ownerId", l.title, l.property_type AS "propertyType", l.price_vnd::float8 AS "priceVnd", l.deposit_amount_vnd::float8 AS "depositAmountVnd", l.area_m2::float8 AS "areaM2", l.address, ${locationColumns('l')}, l.amenities, ST_Y(l.location::geometry) AS lat, ST_X(l.location::geometry) AS lng, l.status, l.created_at AS "createdAt", cover.object_key AS "coverKey"`;

/**
 * Dựng hai câu SQL tìm kiếm (route 11, `RE.LISTING/API_Spec.md §1.3`) từ query đã kiểm.
 *
 * - Mọi giá trị đi qua tham số `$n`; chỉ tên cột, hướng sắp xếp (bảng cố định) nằm trong chuỗi SQL.
 * - `count` và `data` dùng **cùng** mệnh đề WHERE nên `total` luôn khớp tập trả về. Tham số của WHERE
 *   đứng đầu, nên `data` là `count` cộng thêm (điểm cho `distanceM` nếu chưa có) rồi `LIMIT`, `OFFSET`.
 * - Có `radiusKm` thì `ST_DWithin` trên `geography` (mét), dùng index GiST `ix_listings_location`.
 *   Có `lat/lng` mà không `radiusKm`: không lọc, vẫn tính `distanceM`.
 * - Luôn có khóa phụ ổn định (`non-functional-standards.md §1`).
 */
export function buildSearchSql(q: SearchListingsQuery): BuiltSearch {
  const where = [...BASE_CONDITIONS];
  const params: unknown[] = [];
  const add = (value: unknown): string => `$${params.push(value)}`;

  if (q.minPrice !== undefined) where.push(`l.price_vnd >= ${add(q.minPrice)}`);
  if (q.maxPrice !== undefined) where.push(`l.price_vnd <= ${add(q.maxPrice)}`);
  if (q.minArea !== undefined) where.push(`l.area_m2 >= ${add(q.minArea)}`);
  if (q.maxArea !== undefined) where.push(`l.area_m2 <= ${add(q.maxArea)}`);
  if (q.cityId !== undefined) where.push(`l.city_id = ${add(q.cityId)}`);
  if (q.districtId !== undefined) where.push(`l.district_id = ${add(q.districtId)}`);
  if (q.amenities !== undefined && q.amenities.length > 0) {
    where.push(`l.amenities @> ${add(q.amenities)}::text[]`);
  }
  if (q.available === true) where.push(`l.status = 'AVAILABLE'`);

  const hasPoint = q.lat !== undefined && q.lng !== undefined;
  let point: string | undefined; // biểu thức geography của điểm tìm, dùng chung WHERE, SELECT, ORDER BY
  if (hasPoint && q.radiusKm !== undefined) {
    point = pointSql(add(q.lng), add(q.lat));
    where.push(`ST_DWithin(l.location, ${point}, ${add(q.radiusKm * 1000)})`);
  }

  const whereSql = where.join(' AND ');
  const dataParams = [...params];
  const addData = (value: unknown): string => `$${dataParams.push(value)}`;
  if (hasPoint && point === undefined) point = pointSql(addData(q.lng), addData(q.lat));

  const distance = point === undefined ? undefined : `ST_Distance(l.location, ${point})`;
  const columns =
    distance === undefined
      ? SUMMARY_COLUMNS
      : `${SUMMARY_COLUMNS}, round(${distance})::int AS "distanceM"`;

  let orderBy: string;
  switch (q.sort) {
    case 'price_asc':
      orderBy = 'l.price_vnd ASC, l.created_at DESC, l.id DESC';
      break;
    case 'price_desc':
      orderBy = 'l.price_vnd DESC, l.created_at DESC, l.id DESC';
      break;
    case 'distance':
      if (distance === undefined) throw new Error('sort=distance cần lat và lng (đã kiểm ở DTO)');
      orderBy = `${distance} ASC, l.id ASC`;
      break;
    default:
      orderBy = 'l.created_at DESC, l.id DESC';
  }

  const limit = addData(q.pageSize);
  const offset = addData(q.skip);
  return {
    countSql: `SELECT count(*)::int AS total FROM listings l WHERE ${whereSql}`,
    countParams: params,
    dataSql: `SELECT ${columns} FROM listings l ${COVER_JOIN} WHERE ${whereSql} ORDER BY ${orderBy} LIMIT ${limit} OFFSET ${offset}`,
    dataParams,
  };
}
