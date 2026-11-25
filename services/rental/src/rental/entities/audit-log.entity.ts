import { Column, CreateDateColumn, Entity, PrimaryGeneratedColumn } from 'typeorm';

/**
 * Nhật ký thao tác của quản trị viên trên đơn (B12, `RE.DEPOSIT_LIFECYCLE/API_Spec.md §7`), ghi CÙNG transaction
 * với thay đổi. T3.5: `HAND_OVER` trên `DEPOSIT`.
 */
@Entity('audit_log')
export class AuditLog {
  /** `bigserial`: TypeORM trả chuỗi cho bigint, giữ nguyên (chỉ dùng làm khóa). */
  @PrimaryGeneratedColumn({ type: 'bigint' })
  id!: string;

  @Column({ name: 'actor_id', type: 'uuid' })
  actorId!: string;

  @Column({ type: 'varchar', length: 50 })
  action!: string;

  @Column({ name: 'target_type', type: 'varchar', length: 30 })
  targetType!: string;

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
