import { Column, CreateDateColumn, Entity, PrimaryGeneratedColumn } from 'typeorm';

/** Thao tác quản trị được ghi (`RE.PAYOUT/API_Spec.md §1.3`). */
export type AuditAction =
  'COMPLETE_WITHDRAWAL' | 'FAIL_WITHDRAWAL' | 'COMPLETE_REFUND' | 'REJECT_REFUND' | 'FAIL_REFUND';
export type AuditTargetType = 'WITHDRAWAL' | 'REFUND';

/**
 * Nhật ký thao tác quản trị trên lệnh chi (test 14), ghi cùng transaction với thao tác. Chỉ thêm, không sửa.
 * `id` là `bigserial`: driver pg trả chuỗi, giữ nguyên chuỗi (không cần làm phép tính).
 */
@Entity('audit_log')
export class AuditLog {
  @PrimaryGeneratedColumn({ type: 'bigint' })
  id!: string;

  @Column({ name: 'actor_id', type: 'uuid' })
  actorId!: string;

  @Column({ type: 'varchar', length: 50 })
  action!: AuditAction;

  @Column({ name: 'target_type', type: 'varchar', length: 30 })
  targetType!: AuditTargetType;

  @Column({ name: 'target_id', type: 'uuid' })
  targetId!: string;

  @Column({ type: 'jsonb', nullable: true })
  before!: Record<string, unknown> | null;

  @Column({ type: 'jsonb', nullable: true })
  after!: Record<string, unknown> | null;

  @Column({ name: 'correlation_id', type: 'varchar', length: 128, nullable: true })
  correlationId!: string | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;
}
