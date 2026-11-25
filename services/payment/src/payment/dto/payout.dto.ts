import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsIn, IsOptional, IsString, IsUUID, Length } from 'class-validator';
import { PageQueryDto } from '../../common/response/page-query.dto';
import { REFUND_STATUSES } from '../entities/refund-request.entity';
import type { RefundRequesterType, RefundStatus } from '../entities/refund-request.entity';
import { WITHDRAWAL_STATUSES } from '../entities/withdrawal-request.entity';
import type { BankSnapshot, WithdrawalStatus } from '../entities/withdrawal-request.entity';

// ---------------------------------------------------------------------------------------------
// Body, query (`RE.PAYOUT/API_Spec.md §1, §2`)
// ---------------------------------------------------------------------------------------------

/** Route 2: chỉ `depositId`; số tiền do payment tính (`§1.1`), body có thêm trường → `400`. */
export class CreateWithdrawalDto {
  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  depositId!: string;
}

/** API nội bộ `POST /internal/refund-requests` (`contracts/openapi/payment-internal.v1.yaml`). */
export class CreateRefundRequestDto {
  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  depositId!: string;
}

/** Route 7, 9, 10: lý do bắt buộc, cắt khoảng trắng hai đầu, 1–500 ký tự (`§1.3`, khớp `varchar(500)`). */
export class ReasonDto {
  @ApiProperty({ minLength: 1, maxLength: 500 })
  @Transform(({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  @Length(1, 500)
  reason!: string;
}

/** Route 4. */
export class ListWithdrawalsQuery extends PageQueryDto {
  @ApiPropertyOptional({ enum: WITHDRAWAL_STATUSES })
  @IsOptional()
  @IsIn(WITHDRAWAL_STATUSES)
  status?: WithdrawalStatus;
}

/** Route 5. */
export class ListRefundsQuery extends PageQueryDto {
  @ApiPropertyOptional({ enum: REFUND_STATUSES })
  @IsOptional()
  @IsIn(REFUND_STATUSES)
  status?: RefundStatus;
}

/** Route 12. */
export class ListAuditLogsQuery extends PageQueryDto {
  @ApiPropertyOptional({ enum: ['WITHDRAWAL', 'REFUND'] })
  @IsOptional()
  @IsIn(['WITHDRAWAL', 'REFUND'])
  targetType?: 'WITHDRAWAL' | 'REFUND';

  @ApiPropertyOptional({ format: 'uuid' })
  @IsOptional()
  @IsUUID()
  targetId?: string;
}

// ---------------------------------------------------------------------------------------------
// View trả về
// ---------------------------------------------------------------------------------------------

export class BankSnapshotDto implements BankSnapshot {
  @ApiProperty() bankName!: string;
  @ApiProperty() accountHolder!: string;
  @ApiProperty({ description: 'Bốn số cuối' }) accountLast4!: string;
}

export class WithdrawalDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty({ format: 'uuid' }) depositId!: string;
  @ApiProperty({ format: 'uuid' }) ownerId!: string;
  @ApiProperty({ type: 'integer' }) amountVnd!: number;
  @ApiProperty({ type: BankSnapshotDto }) bankSnapshot!: BankSnapshotDto;
  @ApiProperty({ enum: WITHDRAWAL_STATUSES }) status!: WithdrawalStatus;
  @ApiProperty({ type: String, nullable: true }) reason!: string | null;
  @ApiProperty({ type: String, format: 'uuid', nullable: true }) receiptId!: string | null;
  @ApiProperty({ type: String, format: 'uuid', nullable: true }) processedBy!: string | null;
  @ApiProperty({ type: String, format: 'date-time', nullable: true }) processedAt!: string | null;
  @ApiProperty({ format: 'date-time' }) createdAt!: string;
}

export class RefundDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty({ format: 'uuid' }) depositId!: string;
  @ApiProperty({ format: 'uuid' }) tenantId!: string;
  @ApiProperty({ enum: ['TENANT', 'SYSTEM'] }) requesterType!: RefundRequesterType;
  @ApiProperty({ type: 'integer' }) amountVnd!: number;
  @ApiProperty({ enum: REFUND_STATUSES }) status!: RefundStatus;
  @ApiProperty({ type: String, nullable: true }) reason!: string | null;
  @ApiProperty({ type: String, format: 'uuid', nullable: true }) receiptId!: string | null;
  @ApiProperty({ type: String, format: 'uuid', nullable: true }) processedBy!: string | null;
  @ApiProperty({ type: String, format: 'date-time', nullable: true }) processedAt!: string | null;
  @ApiProperty({ format: 'date-time' }) createdAt!: string;
}

/** Số tài khoản đầy đủ: chỉ trả ở route 13, 14 cho quản trị viên; payment không lưu, không log (`§1.5`). */
export class BankAccountDto {
  @ApiProperty() bankName!: string;
  @ApiProperty() accountHolder!: string;
  @ApiProperty() accountNumber!: string;
}

export class WithdrawalDetailDto extends WithdrawalDto {
  @ApiProperty({ type: BankAccountDto, nullable: true, description: 'null: chủ trọ chưa khai' })
  bankAccount!: BankAccountDto | null;
}

export class RefundDetailDto extends RefundDto {
  @ApiProperty({
    type: BankAccountDto,
    nullable: true,
    description: 'null: người thuê chưa khai (thường là tiền đến muộn → hỏi qua chat SUPPORT)',
  })
  bankAccount!: BankAccountDto | null;
}

/** `data` của `RefundRequestResponse` (`payment-internal.v1.yaml`). */
export class InternalRefundDto {
  @ApiProperty({ format: 'uuid' }) refundRequestId!: string;
  @ApiProperty({ format: 'uuid' }) depositId!: string;
  @ApiProperty({ type: 'integer' }) amountVnd!: number;
  @ApiProperty({ enum: ['TENANT'] }) requesterType!: 'TENANT';
  @ApiProperty({ enum: REFUND_STATUSES }) status!: RefundStatus;
}

/** Route 1 (`§1.4`). */
export class WalletTransactionDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty({ enum: ['DEPOSIT_IN', 'LATE_PAYMENT_IN', 'WITHDRAW_OUT', 'REFUND_OUT'] })
  type!: string;
  @ApiProperty({ type: 'integer' }) amountVnd!: number;
  @ApiProperty({ type: String, format: 'uuid', nullable: true }) depositId!: string | null;
  @ApiProperty({ format: 'date-time' }) createdAt!: string;
}

/** Route 11. */
export class WalletSummaryDto {
  @ApiProperty({ type: 'integer' }) balanceVnd!: number;
  @ApiProperty({ type: 'integer', description: 'Tổng lệnh rút PENDING' })
  pendingWithdrawalVnd!: number;
  @ApiProperty({ type: 'integer', description: 'Tổng yêu cầu hoàn PENDING_ADMIN, FAILED' })
  pendingRefundVnd!: number;
}

/** Route 12. */
export class AuditLogDto {
  @ApiProperty() id!: string;
  @ApiProperty({ format: 'uuid' }) actorId!: string;
  @ApiProperty() action!: string;
  @ApiProperty({ enum: ['WITHDRAWAL', 'REFUND'] }) targetType!: string;
  @ApiProperty({ format: 'uuid' }) targetId!: string;
  @ApiProperty({ type: Object, nullable: true }) before!: Record<string, unknown> | null;
  @ApiProperty({ type: Object, nullable: true }) after!: Record<string, unknown> | null;
  @ApiProperty({ type: String, nullable: true }) correlationId!: string | null;
  @ApiProperty({ format: 'date-time' }) createdAt!: string;
}

// ---------------------------------------------------------------------------------------------
// Chuyển dòng SQL (snake_case, bigint là chuỗi) sang view
// ---------------------------------------------------------------------------------------------

/** Một dòng `withdrawal_requests` đọc bằng SQL thô (`SELECT *` / `RETURNING *`). */
export interface WithdrawalRow {
  id: string;
  deposit_id: string;
  owner_id: string;
  amount_vnd: string | number;
  bank_snapshot: BankSnapshot;
  status: WithdrawalStatus;
  reason: string | null;
  receipt_id: string | null;
  processed_by: string | null;
  processed_at: Date | null;
  created_at: Date;
}

/** Một dòng `refund_requests`. */
export interface RefundRow {
  id: string;
  deposit_id: string;
  tenant_id: string;
  requester_type: RefundRequesterType;
  amount_vnd: string | number;
  status: RefundStatus;
  reason: string | null;
  receipt_id: string | null;
  processed_by: string | null;
  processed_at: Date | null;
  created_at: Date;
}

const iso = (d: Date | null): string | null => (d ? new Date(d).toISOString() : null);

export function toWithdrawalDto(r: WithdrawalRow): WithdrawalDto {
  return {
    id: r.id,
    depositId: r.deposit_id,
    ownerId: r.owner_id,
    amountVnd: Number(r.amount_vnd),
    bankSnapshot: r.bank_snapshot,
    status: r.status,
    reason: r.reason,
    receiptId: r.receipt_id,
    processedBy: r.processed_by,
    processedAt: iso(r.processed_at),
    createdAt: new Date(r.created_at).toISOString(),
  };
}

export function toRefundDto(r: RefundRow): RefundDto {
  return {
    id: r.id,
    depositId: r.deposit_id,
    tenantId: r.tenant_id,
    requesterType: r.requester_type,
    amountVnd: Number(r.amount_vnd),
    status: r.status,
    reason: r.reason,
    receiptId: r.receipt_id,
    processedBy: r.processed_by,
    processedAt: iso(r.processed_at),
    createdAt: new Date(r.created_at).toISOString(),
  };
}
