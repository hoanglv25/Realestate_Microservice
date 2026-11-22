import { Column, Entity, PrimaryColumn } from 'typeorm';

/**
 * Inbox: eventId đã xử lý xong. Ghi CÙNG transaction với thay đổi do handler gây ra, nên event
 * giao lại lần hai (RabbitMQ đảm bảo "ít nhất một lần") sẽ bị bỏ qua thay vì xử lý trùng.
 */
@Entity({ name: 'processed_events' })
export class ProcessedEvent {
  @PrimaryColumn({ name: 'event_id', type: 'uuid' })
  eventId!: string;

  @Column({ name: 'event_type', type: 'text' })
  eventType!: string;

  @Column({ name: 'processed_at', type: 'timestamptz', default: () => 'now()' })
  processedAt!: Date;
}
