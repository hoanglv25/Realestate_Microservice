import { Column, CreateDateColumn, Entity, PrimaryColumn } from 'typeorm';
import type { DomainEvent } from '../domain-event';

/**
 * Event chờ gửi lên RabbitMQ. Ghi CÙNG transaction với thay đổi nghiệp vụ (OutboxService.add),
 * OutboxRelay đọc và publish sau. Nhờ vậy DB commit thì event chắc chắn được gửi, rollback thì không.
 */
@Entity({ name: 'outbox_events' })
export class OutboxEvent {
  /** Bằng eventId trong envelope. */
  @PrimaryColumn('uuid')
  id!: string;

  @Column({ name: 'event_type', type: 'text' })
  eventType!: string;

  /** Toàn bộ envelope, publish nguyên văn. */
  @Column({ type: 'jsonb' })
  envelope!: DomainEvent;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;

  /** null = chưa gửi. */
  @Column({ name: 'published_at', type: 'timestamptz', nullable: true })
  publishedAt!: Date | null;

  @Column({ type: 'int', default: 0 })
  attempts!: number;

  @Column({ name: 'last_error', type: 'text', nullable: true })
  lastError!: string | null;
}
