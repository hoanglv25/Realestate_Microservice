import { Column, CreateDateColumn, Entity, PrimaryGeneratedColumn } from 'typeorm';
import { bigintToNumber } from '../../database/transformers';

/** Trạng thái lệnh rút (`RE.PAYOUT/API_Spec.md §7`). `FAILED` là cuối: chủ trọ tạo lệnh mới. */
export const WITHDRAWAL_STATUSES = ['PENDING', 'COMPLETED', 'FAILED'] as const;
export type WithdrawalStatus = (typeof WITHDRAWAL_STATUSES)[number];

/** Bản chụp tài khoản nhận tiền đã che: chỉ bốn số cuối (security-policy, số đầy đủ không lưu ở payment). */
export interface BankSnapshot {
  bankName: string;
  accountHolder: string;
  accountLast4: string;
}

/**
 * Lệnh rút tiền của chủ trọ (BR-15). DDL ở migration `1734000000000` (T3.1). `ux_withdrawal_active`: mỗi đơn
 * một lệnh `PENDING`/`COMPLETED` (BR-16). Đổi trạng thái luôn là `UPDATE ... WHERE status = 'PENDING'`.
 */
@Entity('withdrawal_requests')
export class WithdrawalRequest {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ name: 'deposit_id', type: 'uuid' })
  depositId!: string;

  @Column({ name: 'owner_id', type: 'uuid' })
  ownerId!: string;

  /** Do payment tính (`§1.1`), không nhận từ client. */
  @Column({ name: 'amount_vnd', type: 'bigint', transformer: bigintToNumber })
  amountVnd!: number;

  @Column({ name: 'bank_snapshot', type: 'jsonb' })
  bankSnapshot!: BankSnapshot;

  @Column({ type: 'varchar', length: 20, default: 'PENDING' })
  status!: WithdrawalStatus;

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
