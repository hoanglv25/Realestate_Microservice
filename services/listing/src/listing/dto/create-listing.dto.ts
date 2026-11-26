import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayUnique,
  IsArray,
  IsIn,
  IsInt,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  Length,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import { AMENITIES, Amenity, PROPERTY_TYPES, PropertyType } from '../entities/listing.enums';
import { trim } from './trim';

/** Tiền VND tối đa: số nguyên an toàn của JS (cột `bigint`, `database/transformers.ts`). */
const MAX_VND = Number.MAX_SAFE_INTEGER;

/**
 * Body của `POST /listings` (`RE.LISTING/API_Spec.md §1.1, §1.4`). Không có `ownerId`, `status`,
 * `approvalStatus`: chỉ tin `sub` trong JWT, trạng thái do service đặt.
 */
export class CreateListingDto {
  @ApiProperty({ example: 'Phòng 25m2 gần ĐH Bách Khoa', minLength: 5, maxLength: 200 })
  @Transform(trim)
  @IsString()
  @Length(5, 200)
  title!: string;

  @ApiPropertyOptional({ maxLength: 5000 })
  @IsOptional()
  @IsString()
  @MaxLength(5000)
  description?: string;

  @ApiProperty({ enum: PROPERTY_TYPES })
  @IsIn(PROPERTY_TYPES)
  propertyType!: PropertyType;

  @ApiProperty({ type: 'integer', example: 3500000, description: 'Giá thuê tháng (VND)' })
  @IsInt()
  @Min(1)
  @Max(MAX_VND)
  priceVnd!: number;

  @ApiProperty({ type: 'integer', example: 3500000, description: 'Tiền cọc (VND, BR-04)' })
  @IsInt()
  @Min(1)
  @Max(MAX_VND)
  depositAmountVnd!: number;

  @ApiProperty({
    type: 'number',
    example: 25.5,
    description: 'Diện tích (m²), tối đa 2 chữ số thập phân',
  })
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0.01)
  @Max(999999.99)
  areaM2!: number;

  @ApiProperty({ maxLength: 300 })
  @Transform(trim)
  @IsString()
  @IsNotEmpty()
  @MaxLength(300)
  address!: string;

  @ApiProperty({
    format: 'uuid',
    description: 'Id tỉnh/thành lấy từ GET /cities (RE.LOCATION; v1.5 thay city dạng chuỗi)',
  })
  @IsUUID(undefined, { message: 'cityId phải là UUID' })
  cityId!: string;

  @ApiProperty({
    format: 'uuid',
    description:
      'Id quận/huyện lấy từ GET /districts?cityId=…; phải thuộc cityId (v1.5 thay district dạng chuỗi)',
  })
  @IsUUID(undefined, { message: 'districtId phải là UUID' })
  districtId!: string;

  @ApiPropertyOptional({ enum: AMENITIES, isArray: true, default: [] })
  @IsOptional()
  @IsArray()
  @ArrayUnique()
  @ArrayMaxSize(AMENITIES.length)
  @IsIn(AMENITIES, { each: true, message: `amenities chỉ nhận: ${AMENITIES.join(', ')}` })
  amenities?: Amenity[];

  @ApiProperty({ type: 'number', example: 21.0054, minimum: -90, maximum: 90 })
  @IsNumber()
  @Min(-90)
  @Max(90)
  lat!: number;

  @ApiProperty({ type: 'number', example: 105.8431, minimum: -180, maximum: 180 })
  @IsNumber()
  @Min(-180)
  @Max(180)
  lng!: number;
}
