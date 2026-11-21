import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { EntityManager } from 'typeorm';
import { getCorrelationId } from '../common/logging/correlation-id.middleware';
import { EnvVars } from '../config/env.validation';
import { buildDomainEvent, DomainEvent } from './domain-event';

/**
 * Ghi event vào outbox. LUÔN truyền `manager` của transaction đang thay đổi dữ liệu nghiệp vụ:
 *
 *   await this.dataSource.transaction(async (manager) => {
 *     const r = await manager.save(Reservation, { ... });
 *     await this.outbox.add(manager, 'rental.requested', { reservationId: r.id, ... });
 *   });
 *
 * Event chỉ được gửi lên RabbitMQ (bởi OutboxRelay) sau khi transaction commit.
 * Payload phải khớp schema trong contracts/events/ (kiểm tra bằng test, xem test/helpers/contracts.ts).
 */
@Injectable()
export class OutboxService {
  private readonly producer: string;

  constructor(config: ConfigService<EnvVars, true>) {
    this.producer = config.get('SERVICE_NAME', { infer: true });
  }

  async add<TPayload extends object>(
    manager: EntityManager,
    eventType: string,
    payload: TPayload,
    options: { version?: number; occurredAt?: Date } = {},
  ): Promise<DomainEvent<TPayload>> {
    if (!manager.queryRunner?.isTransactionActive) {
      // Ghi ngoài transaction thì mất đảm bảo "dữ liệu và event cùng thành công hoặc cùng thất bại"
      throw new Error(
        'OutboxService.add phải được gọi bên trong transaction (dataSource.transaction)',
      );
    }
    const event = buildDomainEvent({
      eventType,
      payload,
      producer: this.producer,
      version: options.version,
      occurredAt: options.occurredAt,
      correlationId: getCorrelationId(),
    });
    await manager.query(
      `INSERT INTO outbox_events (id, event_type, envelope) VALUES ($1, $2, $3::jsonb)`,
      [event.eventId, event.eventType, JSON.stringify(event)],
    );
    return event;
  }
}
