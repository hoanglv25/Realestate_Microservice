import { Amenity, ApprovalStatus, PropertyType } from '../entities/listing.enums';

/**
 * Quy tắc "sửa gì thì phải duyệt lại" (`RE.LISTING/API_Spec.md §1.1`). Hàm thuần, không đụng DB:
 * service đọc dòng hiện tại (khóa `FOR UPDATE`), gọi `classifyEdit` rồi `resubmits`.
 *
 * | Trạng thái duyệt | Sửa gì                                              | Kết quả          |
 * | APPROVED         | title, description, propertyType, address, cityId,  | PENDING_REVIEW   |
 * |                  | districtId, lat/lng, hoặc thêm ảnh (v1.5)           |                  |
 * | APPROVED         | priceVnd, depositAmountVnd, areaM2, amenities       | giữ APPROVED     |
 * | REJECTED         | bất kỳ trường nào, hoặc thêm ảnh                    | PENDING_REVIEW   |
 * | PENDING_REVIEW   | bất kỳ                                              | giữ              |
 */

/** Các trường người dùng sửa được (route 1, 2). */
export interface EditableFields {
  title: string;
  description: string | null;
  propertyType: PropertyType | string;
  priceVnd: number;
  depositAmountVnd: number;
  areaM2: number;
  address: string | null;
  cityId: string;
  districtId: string;
  amenities: readonly (Amenity | string)[];
  lat: number;
  lng: number;
}

/** Trường làm đổi nội dung hiển thị: tin `APPROVED` bị sửa các trường này phải duyệt lại. */
const DISPLAY_FIELDS: ReadonlySet<string> = new Set([
  'title',
  'description',
  'propertyType',
  'address',
  'cityId',
  'districtId',
  'lat',
  'lng',
  'images',
]);

export interface EditClassification {
  /** Tên các trường thật sự đổi giá trị. */
  changed: string[];
  /** Có ít nhất một trường nội dung hiển thị đổi (hoặc thêm ảnh). */
  display: boolean;
}

const sameAmenities = (a: readonly string[], b: readonly string[]): boolean =>
  a.length === b.length && [...a].sort().every((v, i) => v === [...b].sort()[i]);

/** Chuỗi rỗng và `null` coi như nhau (mô tả không có). */
const text = (v: string | null | undefined): string => v ?? '';

/**
 * So `patch` với giá trị hiện tại, chỉ tính trường có trong `patch` và khác giá trị cũ.
 * `amenities` so như tập (thứ tự không quan trọng).
 */
export function classifyEdit(
  current: EditableFields,
  patch: Partial<EditableFields>,
): EditClassification {
  const changed: string[] = [];
  for (const [key, value] of Object.entries(patch) as Array<[keyof EditableFields, unknown]>) {
    if (value === undefined) continue;
    const before = current[key];
    const differs =
      key === 'amenities'
        ? !sameAmenities(before as readonly string[], value as readonly string[])
        : key === 'description' || key === 'address'
          ? text(before as string | null) !== text(value as string | null)
          : before !== value;
    if (differs) changed.push(key);
  }
  return { changed, display: changed.some((f) => DISPLAY_FIELDS.has(f)) };
}

/**
 * Sau lần sửa này, tin có phải về `PENDING_REVIEW` không?
 * Thêm ảnh truyền `{ changed: ['images'], display: true }`.
 */
export function resubmits(approval: ApprovalStatus, edit: EditClassification): boolean {
  if (approval === 'APPROVED') return edit.display;
  if (approval === 'REJECTED') return edit.changed.length > 0;
  return false;
}
