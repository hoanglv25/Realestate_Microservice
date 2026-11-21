import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsIn, IsOptional, IsString, IsUUID, MaxLength } from 'class-validator';
import { PageQueryDto } from '../../common/response/page-query.dto';
import { VIEWING_STATUSES } from '../entities/viewing.entity';
import type { Viewing, ViewingCancelReason, ViewingStatus } from '../entities/viewing.entity';

const trim = ({ value }: { value: unknown }): unknown =>
  typeof value === 'string' ? value.trim() : value;

/** Body `POST /viewings` (route 1). Không có giờ hẹn: hai bên thống nhất qua chat (RE.VIEWING). */
export class CreateViewingDto {
  @ApiProperty({ format: 'uuid' })
  @IsUUID(undefined, { message: 'listingId phải là UUID' })
  listingId!: string;

  @ApiPropertyOptional({ maxLength: 500, example: 'Tôi muốn xem vào cuối tuần' })
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(500)
  note?: string;
}

/** Body `POST /viewings/:id/respond` (route 2): chủ trọ chỉ có thể từ chối (chốt 2026-11-16). */
export class RespondViewingDto {
  @ApiProperty({ enum: ['DECLINE'] })
  @IsIn(['DECLINE'])
  decision!: 'DECLINE';

  /** Nhận cho đúng hợp đồng route; chưa lưu (bảng `viewings` chỉ có `note` của người thuê). */
  @ApiPropertyOptional({ maxLength: 500 })
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(500)
  note?: string;
}

/** Query `GET /viewings/mine` (route 4). */
export class ListViewingsQuery extends PageQueryDto {
  @ApiPropertyOptional({ format: 'uuid' })
  @IsOptional()
  @IsUUID(undefined, { message: 'listingId phải là UUID' })
  listingId?: string;

  @ApiPropertyOptional({ enum: VIEWING_STATUSES })
  @IsOptional()
  @IsIn(VIEWING_STATUSES)
  status?: ViewingStatus;
}

/** Lịch xem trả ra ngoài (danh sách trắng các trường). */
export class ViewingDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty({ format: 'uuid' }) listingId!: string;
  @ApiProperty() listingTitle!: string;
  @ApiProperty({ format: 'uuid' }) tenantId!: string;
  @ApiProperty({ format: 'uuid' }) ownerId!: string;
  @ApiProperty({ enum: VIEWING_STATUSES }) status!: ViewingStatus;
  @ApiProperty({ enum: ['TENANT', 'LISTING_DEPOSITED'], nullable: true })
  cancelReason!: ViewingCancelReason | null;
  @ApiProperty({ type: String, nullable: true }) note!: string | null;
  @ApiProperty({ format: 'date-time' }) createdAt!: string;

  static from(v: Viewing): ViewingDto {
    return {
      id: v.id,
      listingId: v.listingId,
      listingTitle: v.listingTitle,
      tenantId: v.tenantId,
      ownerId: v.ownerId,
      status: v.status,
      cancelReason: v.cancelReason,
      note: v.note,
      createdAt: v.createdAt.toISOString(),
    };
  }
}
