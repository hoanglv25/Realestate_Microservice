import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsOptional, IsUUID } from 'class-validator';
import { PageQueryDto } from '../../common/response/page-query.dto';
import { allowedActions } from '../domain/deposit-state';
import type { Caller, DepositAction } from '../domain/deposit-state';
import { DEPOSIT_STATUSES } from '../entities/deposit.entity';
import type { Deposit, DepositStatus, ReleaseTrigger } from '../entities/deposit.entity';

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

// ---------- Vòng đời đơn (RE.DEPOSIT_LIFECYCLE, T3.5) ----------

/** Query route 1 `GET /deposits/mine`, route 5 `GET /admin/deposits` (chốt T3.5 B3). */
export class ListDepositsQuery extends PageQueryDto {
  @ApiPropertyOptional({ enum: DEPOSIT_STATUSES })
  @IsOptional()
  @IsIn(DEPOSIT_STATUSES)
  status?: DepositStatus;
}

/**
 * Đơn trả ra ngoài (danh sách trắng, chốt T3.5 B1). `checkoutUrl`, `qrCode`, `expiresAt` chỉ có khi người gọi là
 * người thuê chủ đơn và đơn còn `PENDING_PAYMENT` (để trả tiền tiếp).
 */
export class DepositDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty({ format: 'uuid' }) listingId!: string;
  @ApiProperty() listingTitle!: string;
  @ApiProperty({ format: 'uuid' }) tenantId!: string;
  @ApiProperty({ format: 'uuid' }) ownerId!: string;
  @ApiProperty({ example: 3000000 }) amountVnd!: number;
  @ApiProperty({ enum: DEPOSIT_STATUSES }) status!: DepositStatus;
  @ApiProperty({ type: String, format: 'date-time', nullable: true }) paidAt!: string | null;
  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  refundDeadlineAt!: string | null;
  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  autoReleaseAt!: string | null;
  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  adminConfirmedAt!: string | null;
  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  sellerAcknowledgedAt!: string | null;
  @ApiProperty({ type: String, format: 'date-time', nullable: true }) releasedAt!: string | null;
  @ApiProperty({ type: String, enum: ['TENANT', 'AUTO'], nullable: true })
  releaseTrigger!: ReleaseTrigger | null;
  @ApiProperty({ type: String, format: 'date-time', nullable: true }) refundedAt!: string | null;
  @ApiProperty({ type: String, format: 'date-time', nullable: true }) withdrawnAt!: string | null;
  @ApiProperty({ format: 'date-time' }) createdAt!: string;
  @ApiProperty({
    enum: ['CONFIRM_MOVE_IN', 'REQUEST_REFUND', 'ACKNOWLEDGE', 'HAND_OVER'],
    isArray: true,
  })
  allowedActions!: DepositAction[];
  @ApiPropertyOptional() checkoutUrl?: string | null;
  @ApiPropertyOptional() qrCode?: string | null;
  @ApiPropertyOptional({ format: 'date-time' }) expiresAt?: string;

  static from(d: Deposit, caller: Caller, now: Date): DepositDto {
    const iso = (x: Date | null): string | null => (x ? x.toISOString() : null);
    const dto: DepositDto = {
      id: d.id,
      listingId: d.listingId,
      listingTitle: d.listingTitle,
      tenantId: d.tenantId,
      ownerId: d.ownerId,
      amountVnd: d.amountVnd,
      status: d.status,
      paidAt: iso(d.paidAt),
      refundDeadlineAt: iso(d.refundDeadlineAt),
      autoReleaseAt: iso(d.autoReleaseAt),
      adminConfirmedAt: iso(d.adminConfirmedAt),
      sellerAcknowledgedAt: iso(d.sellerAcknowledgedAt),
      releasedAt: iso(d.releasedAt),
      releaseTrigger: d.releaseTrigger,
      refundedAt: iso(d.refundedAt),
      withdrawnAt: iso(d.withdrawnAt),
      createdAt: d.createdAt.toISOString(),
      allowedActions: allowedActions(d, caller, now),
    };
    if (d.status === 'PENDING_PAYMENT' && d.tenantId === caller.sub) {
      dto.checkoutUrl = d.checkoutUrl;
      dto.qrCode = d.qrCode;
      dto.expiresAt = d.expiresAt.toISOString();
    }
    return dto;
  }
}

/** `200` của `GET /internal/deposits/:id/withdrawal-eligibility` (`rental-internal.v1.yaml`, BR-15 sửa). */
export class WithdrawalEligibilityDto {
  @ApiProperty({ format: 'uuid' }) depositId!: string;
  @ApiProperty({ format: 'uuid' }) ownerId!: string;
  @ApiProperty() amountVnd!: number;
  @ApiProperty({ enum: DEPOSIT_STATUSES }) status!: DepositStatus;
  @ApiProperty() eligible!: boolean;
  @ApiProperty({ enum: ['NOT_RELEASED', 'NOT_HANDED_OVER', 'NOT_ACKNOWLEDGED'], isArray: true })
  missing!: WithdrawalMissing[];
}
export type WithdrawalMissing = 'NOT_RELEASED' | 'NOT_HANDED_OVER' | 'NOT_ACKNOWLEDGED';
