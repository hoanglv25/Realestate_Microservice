import { randomUUID } from 'node:crypto';
import type { Client } from 'pg';

/**
 * Tin dựng bằng SQL trực tiếp cho test hạ tầng (đặt được `status`, `approval_status`, `held_*` mà API không cho).
 * `district`, `city` là TÊN trong danh mục `RE.LOCATION`; `insertListing` tra ra `city_id`, `district_id`
 * (v1.5). Tên không có trong danh mục → INSERT lỗi `NOT NULL` (fixture sai, không lặng lẽ bỏ qua).
 */
export interface FixtureListing {
  ownerId?: string;
  title?: string;
  description?: string | null;
  propertyType?: 'ROOM' | 'APARTMENT' | 'HOUSE';
  priceVnd?: number;
  depositAmountVnd?: number;
  areaM2?: number;
  address?: string;
  district?: string;
  city?: string;
  amenities?: string[];
  lat?: number;
  lng?: number;
  status?: 'AVAILABLE' | 'HELD' | 'DEPOSITED' | 'RENTED' | 'HIDDEN';
  approvalStatus?: 'PENDING_REVIEW' | 'APPROVED' | 'REJECTED';
  heldUntil?: Date | null;
  heldByDepositId?: string | null;
  deletedAt?: Date | null;
  createdAt?: Date;
}

/** Mặc định: tin đã duyệt, `AVAILABLE`, tại Bách Khoa Hà Nội. Trả `id`. */
export async function insertListing(pg: Client, over: FixtureListing = {}): Promise<string> {
  const f = {
    ownerId: randomUUID(),
    title: 'Phòng 25m2 gần ĐH Bách Khoa',
    description: null,
    propertyType: 'ROOM',
    priceVnd: 3500000,
    depositAmountVnd: 3500000,
    areaM2: 25.5,
    address: '1 Đại Cồ Việt',
    district: 'Hai Bà Trưng',
    city: 'Hà Nội',
    amenities: [] as string[],
    lat: 21.0054,
    lng: 105.8431,
    status: 'AVAILABLE',
    approvalStatus: 'APPROVED',
    heldUntil: null,
    heldByDepositId: null,
    deletedAt: null,
    createdAt: new Date(),
    ...over,
  };
  const res = await pg.query<{ id: string }>(
    `INSERT INTO listings
       (owner_id, title, description, property_type, price_vnd, deposit_amount_vnd, area_m2,
        address, city_id, district_id, amenities, location, status, approval_status,
        held_until, held_by_deposit_id, deleted_at, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8,
             (SELECT id FROM cities WHERE name = $10),
             (SELECT d.id FROM districts d JOIN cities c ON c.id = d.city_id
               WHERE c.name = $10 AND d.name = $9),
             $11::text[],
             ST_SetSRID(ST_MakePoint($13, $12), 4326)::geography, $14, $15,
             $16::timestamptz, $17::uuid, $18::timestamptz, $19::timestamptz, $19::timestamptz)
     RETURNING id`,
    [
      f.ownerId,
      f.title,
      f.description,
      f.propertyType,
      f.priceVnd,
      f.depositAmountVnd,
      f.areaM2,
      f.address,
      f.district,
      f.city,
      f.amenities,
      f.lat,
      f.lng,
      f.status,
      f.approvalStatus,
      f.heldUntil,
      f.heldByDepositId,
      f.deletedAt,
      f.createdAt,
    ],
  );
  return res.rows[0].id;
}

/** Khoảng cách đường tròn lớn (mét), mô hình cầu: đối chứng ĐỘC LẬP với `ST_Distance` (spheroid, lệch < 0,5%). */
export function haversineM(
  a: { lat: number; lng: number },
  b: { lat: number; lng: number },
): number {
  const rad = (d: number) => (d * Math.PI) / 180;
  const h =
    Math.sin(rad(b.lat - a.lat) / 2) ** 2 +
    Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(rad(b.lng - a.lng) / 2) ** 2;
  return 2 * 6371008.8 * Math.asin(Math.sqrt(h));
}
