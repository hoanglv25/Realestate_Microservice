import { Global, Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { OutboxEvent } from './entities/outbox-event.entity';
import { ProcessedEvent } from './entities/processed-event.entity';
import { EventConsumer } from './event.consumer';
import { EventHandlerRegistry } from './event-handler.registry';
import { OutboxRelay } from './outbox.relay';
import { OutboxService } from './outbox.service';
import { RabbitMqConnection } from './rabbitmq.connection';

/**
 * TÙY CHỌN: chỉ được nạp khi có RABBITMQ_URL (bắt buộc kèm DATABASE_URL), xem app.module.ts.
 *
 * - Publish: `OutboxService.add(manager, eventType, payload)` trong transaction nghiệp vụ.
 * - Consume: đặt RABBITMQ_QUEUE rồi đăng ký handler qua `EventHandlerRegistry.on(...)`.
 * - Cần migration CreateMessagingTables (bảng outbox_events, processed_events).
 * - Exchange/queue KHÔNG được tạo ở đây; chúng nằm trong infra/rabbitmq/definitions.json.
 */
@Global()
@Module({
  imports: [TypeOrmModule.forFeature([OutboxEvent, ProcessedEvent])],
  providers: [RabbitMqConnection, OutboxService, OutboxRelay, EventHandlerRegistry, EventConsumer],
  exports: [OutboxService, EventHandlerRegistry],
})
export class MessagingModule {}
