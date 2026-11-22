import { ApiProperty } from '@nestjs/swagger';
import { IsUUID } from 'class-validator';

/** Body `POST /deposits`. Số tiền KHÔNG nhận từ client (BR-04): lấy từ bản chụp listing. */
export class CreateDepositDto {
  @ApiProperty({ format: 'uuid' })
  @IsUUID(undefined, { message: 'listingId phải là UUID' })
  listingId!: string;
}

/** `201` của `POST /deposits` (`RE.DEPOSIT_SAGA/API_Spec.md §1`). */
export class DepositCreatedDto {
  @ApiProperty({ format: 'uuid' }) depositId!: string;
  @ApiProperty({ enum: ['PENDING_PAYMENT'] }) status!: 'PENDING_PAYMENT';
  @ApiProperty({ format: 'uuid' }) listingId!: string;
  @ApiProperty({ example: 3000000 }) amountVnd!: number;
  @ApiProperty({ format: 'date-time' }) expiresAt!: string;
  @ApiProperty({ example: 598, description: 'Số giây giữ chỗ còn lại' })
  holdRemainingSeconds!: number;
  @ApiProperty() checkoutUrl!: string;
  @ApiProperty() qrCode!: string;
}
