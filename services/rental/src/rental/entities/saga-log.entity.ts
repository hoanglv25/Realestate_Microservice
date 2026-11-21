import { Column, CreateDateColumn, Entity, PrimaryGeneratedColumn } from 'typeorm';

export const SAGA_STEPS = [
  'HOLD_LISTING',
  'CREATE_PAYMENT_ORDER',
  'CANCEL_PAYMENT_ORDER',
  'RELEASE_LISTING',
  'SYNC_LISTING',
] as const;
export type SagaStep = (typeof SAGA_STEPS)[number];

/** Kết quả một bước (`RE.DEPOSIT_SAGA/Component_Class_Design.md §3`). */
export type SagaOutcome = 'OK' | 'BUSINESS_ERROR' | 'NOT_EXECUTED' | 'UNKNOWN';

/** Nhật ký từng bước saga của một đơn (chỉ ghi sau khi đã có `deposits`, khóa ngoại). */
@Entity('saga_log')
export class SagaLog {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ name: 'deposit_id', type: 'uuid' })
  depositId!: string;

  @Column({ type: 'varchar', length: 40 })
  step!: SagaStep;

  @Column({ type: 'varchar', length: 20 })
  outcome!: SagaOutcome;

  /** Mã lỗi, HTTP status khi bước lỗi; không chứa dữ liệu cá nhân. */
  @Column({ type: 'jsonb', nullable: true })
  detail!: Record<string, unknown> | null;

  @Column({ name: 'correlation_id', type: 'varchar', length: 128, nullable: true })
  correlationId!: string | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;
}
