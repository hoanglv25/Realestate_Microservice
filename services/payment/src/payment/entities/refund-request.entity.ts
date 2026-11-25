import { Column, CreateDateColumn, Entity, PrimaryGeneratedColumn } from 'typeorm';
import { bigintToNumber } from '../../database/transformers';

/** Trạng thái yêu cầu hoàn (`RE.PAYOUT/API_Spec.md §7`). `FAILED` được hoàn tất lại. */
export const REFUND_STATUSES = ['PENDING_ADMIN', 'COMPLETED', 'REJECTED', 'FAILED'] as const;
export type RefundStatus = (typeof REFUND_STATUSES)[number];
/** `TENANT`: người thuê tự hủy, hoàn 70% (BR-12). `SYSTEM`: tiền đến muộn, hoàn 100% (BR-10). */
export type RefundRequesterType = 'TENANT' | 'SYSTEM';

/**
 * Yêu cầu hoàn tiền cho người thuê. DDL ở migration `1734000000000` (T3.1). `ux_refund_tenant_active`: mỗi đơn
 * một yêu cầu `TENANT` đang mở hoặc đã xong (`REJECTED` không tính: người thuê xin lại được, `§2`).
 * Đổi trạng thái luôn là `UPDATE ... WHERE status = <từ>` (hai quản trị viên cùng bấm, `§1.2`).
 */
@Entity('refund_requests')
export class RefundRequest {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ name: 'deposit_id', type: 'uuid' })
  depositId!: string;

  @Column({ name: 'tenant_id', type: 'uuid' })
  tenantId!: string;

  @Column({ name: 'requester_type', type: 'varchar', length: 10 })
  requesterType!: RefundRequesterType;

  @Column({ name: 'amount_vnd', type: 'bigint', transformer: bigintToNumber })
  amountVnd!: number;

  @Column({ type: 'varchar', length: 20, default: 'PENDING_ADMIN' })
  status!: RefundStatus;

  /** Lý do từ chối hoặc thất bại (1–500 ký tự). */
  @Column({ type: 'varchar', length: 500, nullable: true })
  reason!: string | null;

  @Column({ name: 'receipt_id', type: 'uuid', nullable: true })
  receiptId!: string | null;

  @Column({ name: 'processed_by', type: 'uuid', nullable: true })
  processedBy!: string | null;

  @Column({ name: 'processed_at', type: 'timestamptz', nullable: true })
  processedAt!: Date | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;
}
