import { ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsNumber,
  IsOptional,
  IsUUID,
  Max,
  Min,
  Validate,
  ValidateIf,
  ValidationArguments,
  ValidatorConstraint,
  ValidatorConstraintInterface,
} from 'class-validator';
import { PageQueryDto } from '../../common/response/page-query.dto';
import { AMENITIES, Amenity } from '../entities/listing.enums';

/** Cách sắp xếp của route 11 (`RE.LISTING/API_Spec.md §1.3`). `distance` cần `lat` và `lng`. */
export const SEARCH_SORTS = ['newest', 'price_asc', 'price_desc', 'distance'] as const;
export type SearchSort = (typeof SEARCH_SORTS)[number];

/** Bán kính tối đa (km). `0 < radiusKm ≤ 50` (chốt 2026-11-20). */
export const MAX_RADIUS_KM = 50;

/** `amenities=WIFI,PARKING` hoặc `?amenities=WIFI&amenities=PARKING` → `['WIFI', 'PARKING']`; rỗng → `[]`. */
const toAmenityList = ({ value }: { value: unknown }): unknown => {
  if (value === undefined || value === null) return value;
  const parts = Array.isArray(value) ? value : [value];
  if (!parts.every((p) => typeof p === 'string')) return value;
  return parts
    .flatMap((p: string) => p.split(','))
    .map((p) => p.trim())
    .filter((p) => p.length > 0);
};

/**
 * Chuỗi rỗng từ form (`?minPrice=&lat=`) coi như không có tham số. Nếu không, `@Type(() => Number)` đổi
 * '' thành 0 và âm thầm lọc `minPrice >= 0` hoặc tìm tại tọa độ (0, 0). Dùng cùng `@Type(() => Number)`.
 */
const emptyToUndefined = ({
  value,
  obj,
  key,
}: {
  value: unknown;
  obj: Record<string, unknown>;
  key: string;
}): unknown => (obj[key] === '' ? undefined : value);

/** `available=true|false` → boolean; giá trị khác giữ nguyên để `@IsBoolean` báo lỗi. */
const toBoolean = ({ value }: { value: unknown }): unknown =>
  value === 'true' ? true : value === 'false' ? false : value;

/** Giá trị phải ≥ trường `minField` (hai đầu đều được) khi cả hai cùng có. */
@ValidatorConstraint({ name: 'isNotLessThanField', async: false })
class IsNotLessThanField implements ValidatorConstraintInterface {
  validate(value: unknown, args: ValidationArguments): boolean {
    const other = (args.object as Record<string, unknown>)[args.constraints[0] as string];
    if (typeof value !== 'number' || typeof other !== 'number') return true;
    return value >= other;
  }

  defaultMessage(args: ValidationArguments): string {
    return `${args.property} phải lớn hơn hoặc bằng ${args.constraints[0] as string}`;
  }
}

/** `lat`, `lng` bắt buộc khi có một trong `lat`, `lng`, `radiusKm`, hoặc `sort=distance`. */
const needsPoint = (q: SearchListingsQuery): boolean =>
  q.lat !== undefined || q.lng !== undefined || q.radiusKm !== undefined || q.sort === 'distance';

const POINT_MESSAGE = (name: string): string =>
  `${name} là bắt buộc khi có lat, lng, radiusKm hoặc sort=distance (lat và lng phải đi cùng nhau)`;

/**
 * Query của `GET /listings` (route 11, `RE.LISTING/API_Spec.md §1.3`). Mọi bộ lọc tùy chọn; mọi tham số
 * sai → `400 VALIDATION_FAILED` qua ValidationPipe toàn cục.
 *
 * Lưu ý class-validator: `@IsOptional()` + `@ValidateIf()` trên cùng thuộc tính được AND với nhau
 * (thiếu giá trị thì bỏ qua kiểm), nên `lat`/`lng` chỉ dùng `@ValidateIf` để thiếu một trong hai bị báo lỗi.
 */
export class SearchListingsQuery extends PageQueryDto {
  @ApiPropertyOptional({ type: 'integer', minimum: 0, description: 'Giá thuê tối thiểu (VND)' })
  @IsOptional()
  @Type(() => Number)
  @Transform(emptyToUndefined)
  @IsInt()
  @Min(0)
  minPrice?: number;

  @ApiPropertyOptional({ type: 'integer', minimum: 0, description: 'Giá thuê tối đa (VND)' })
  @IsOptional()
  @Type(() => Number)
  @Transform(emptyToUndefined)
  @IsInt()
  @Min(0)
  @Validate(IsNotLessThanField, ['minPrice'])
  maxPrice?: number;

  @ApiPropertyOptional({ type: 'number', minimum: 0, description: 'Diện tích tối thiểu (m²)' })
  @IsOptional()
  @Type(() => Number)
  @Transform(emptyToUndefined)
  @IsNumber()
  @Min(0)
  minArea?: number;

  @ApiPropertyOptional({ type: 'number', minimum: 0, description: 'Diện tích tối đa (m²)' })
  @IsOptional()
  @Type(() => Number)
  @Transform(emptyToUndefined)
  @IsNumber()
  @Min(0)
  @Validate(IsNotLessThanField, ['minArea'])
  maxArea?: number;

  @ApiPropertyOptional({
    format: 'uuid',
    description: 'Tỉnh/thành (id từ GET /cities, v1.5). Id không có → kết quả rỗng',
  })
  @IsOptional()
  @IsUUID(undefined, { message: 'cityId phải là UUID' })
  cityId?: string;

  @ApiPropertyOptional({
    format: 'uuid',
    description:
      'Quận/huyện (id từ GET /districts, v1.5 thay district dạng chuỗi). Id không có → kết quả rỗng',
  })
  @IsOptional()
  @IsUUID(undefined, { message: 'districtId phải là UUID' })
  districtId?: string;

  @ApiPropertyOptional({
    type: 'string',
    example: 'WIFI,PARKING',
    description: `CSV, tin phải có mọi tiện ích. Mã hợp lệ: ${AMENITIES.join(', ')}`,
  })
  @IsOptional()
  @Transform(toAmenityList)
  @IsArray()
  @ArrayMaxSize(AMENITIES.length)
  @IsIn(AMENITIES, { each: true, message: `amenities chỉ nhận: ${AMENITIES.join(', ')}` })
  amenities?: Amenity[];

  @ApiPropertyOptional({
    type: 'boolean',
    description: 'true: chỉ tin AVAILABLE. Không có hoặc false: không lọc thêm (luôn loại HIDDEN)',
  })
  @IsOptional()
  @Transform(toBoolean)
  @IsBoolean()
  available?: boolean;

  @ApiPropertyOptional({ type: 'number', minimum: -90, maximum: 90, example: 21.0054 })
  @ValidateIf(needsPoint)
  @Type(() => Number)
  @Transform(emptyToUndefined)
  @IsNumber({}, { message: POINT_MESSAGE('lat') })
  @Min(-90)
  @Max(90)
  lat?: number;

  @ApiPropertyOptional({ type: 'number', minimum: -180, maximum: 180, example: 105.8431 })
  @ValidateIf(needsPoint)
  @Type(() => Number)
  @Transform(emptyToUndefined)
  @IsNumber({}, { message: POINT_MESSAGE('lng') })
  @Min(-180)
  @Max(180)
  lng?: number;

  @ApiPropertyOptional({
    type: 'number',
    maximum: MAX_RADIUS_KM,
    example: 2,
    description:
      'Bán kính (km), lớn hơn 0 và tối đa 50, cần lat và lng. Có lat/lng mà không có radiusKm: không lọc bán kính, vẫn trả distanceM',
  })
  @IsOptional()
  @Type(() => Number)
  @Transform(emptyToUndefined)
  @IsNumber()
  @Min(Number.MIN_VALUE, { message: 'radiusKm phải lớn hơn 0' })
  @Max(MAX_RADIUS_KM)
  radiusKm?: number;

  @ApiPropertyOptional({
    enum: SEARCH_SORTS,
    default: 'newest',
    description: 'distance cần lat, lng',
  })
  @IsIn(SEARCH_SORTS)
  sort: SearchSort = 'newest';
}
