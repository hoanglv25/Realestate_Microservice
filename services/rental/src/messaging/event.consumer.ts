import { Injectable, OnApplicationBootstrap, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { ChannelWrapper } from 'amqp-connection-manager';
import type { Channel, ConsumeMessage } from 'amqplib';
import { PinoLogger } from 'nestjs-pino';
import { CLS_ID, ClsService } from 'nestjs-cls';
import { setTimeout as sleep } from 'node:timers/promises';
import { DataSource } from 'typeorm';
import { EnvVars } from '../config/env.validation';
import { checkEnvelope, DomainEvent } from './domain-event';
import { EventHandlerRegistry, NonRetryableEventError } from './event-handler.registry';
import { RabbitMqConnection } from './rabbitmq.connection';

/** Kết quả xử lý một message (dùng cho log và test). */
export type ConsumeOutcome = 'processed' | 'duplicate' | 'ignored' | 'dead-lettered' | 'requeued';

/** Thời gian chờ trước lần thử lại thứ `attempt` (bắt đầu từ 0): 200ms, 400ms, 800ms... tối đa 5s. */
export const retryDelayMs = (attempt: number): number => Math.min(200 * 2 ** attempt, 5000);

/**
 * Đọc queue RABBITMQ_QUEUE (bỏ trống = service chỉ publish, không consume).
 *
 * Mỗi message:
 * 1. JSON hỏng hoặc envelope sai -> DLQ ngay.
 * 2. Không có handler cho eventType -> ack, bỏ qua.
 * 3. Một transaction: INSERT eventId vào processed_events (đã có -> trùng, bỏ qua) rồi chạy handler.
 *    Commit xong mới ack.
 * 4. Handler lỗi -> thử lại tối đa RABBITMQ_MAX_RETRIES lần (chờ tăng dần), vẫn lỗi -> nack không
 *    requeue -> RabbitMQ chuyển sang <queue>.dlq. NonRetryableEventError -> DLQ ngay.
 */
@Injectable()
export class EventConsumer implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly queue?: string;
  private readonly prefetch: number;
  private readonly maxRetries: number;
  private channel?: ChannelWrapper;
  private readonly inFlight = new Set<Promise<unknown>>();
  private stopping = false;

  constructor(
    config: ConfigService<EnvVars, true>,
    private readonly connection: RabbitMqConnection,
    private readonly registry: EventHandlerRegistry,
    private readonly dataSource: DataSource,
    private readonly cls: ClsService,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(EventConsumer.name);
    this.queue = config.get('RABBITMQ_QUEUE', { infer: true });
    this.prefetch = config.get('RABBITMQ_PREFETCH', { infer: true });
    this.maxRetries = config.get('RABBITMQ_MAX_RETRIES', { infer: true });
  }

  /** Bắt đầu consume SAU khi mọi module đã đăng ký handler (onModuleInit). */
  onApplicationBootstrap(): void {
    const queue = this.queue;
    if (!queue) return;
    if (this.registry.eventTypes().length === 0) {
      this.logger.warn({ queue }, 'Có RABBITMQ_QUEUE nhưng chưa đăng ký handler nào');
    }
    this.channel = this.connection.manager.createChannel({
      name: `consumer:${queue}`,
      confirm: false,
      setup: async (channel: Channel) => {
        await channel.checkQueue(queue);
      },
    });
    this.channel.on('error', (err) =>
      this.logger.error(
        { err, queue },
        `Queue "${queue}" không tồn tại hoặc lỗi kênh consume. Kiểm tra infra/rabbitmq/definitions.json.`,
      ),
    );
    // Không await: RabbitMQ chưa sẵn sàng thì service vẫn khởi động, kết nối lại sẽ tự consume
    this.channel
      .consume(queue, (msg) => this.track(this.handle(msg)), { prefetch: this.prefetch })
      .then(() =>
        this.logger.info({ queue, eventTypes: this.registry.eventTypes() }, 'Bắt đầu nhận event'),
      )
      .catch((err) => this.logger.error({ err, queue }, 'Không consume được queue'));
  }

  /** Ngừng nhận message mới, chờ message đang xử lý xong (trước khi đóng DB và RabbitMQ). */
  async onModuleDestroy(): Promise<void> {
    this.stopping = true;
    await this.channel?.cancelAll().catch(() => undefined);
    await Promise.allSettled([...this.inFlight]);
    await this.channel?.close().catch(() => undefined);
  }

  /** Xử lý một message và ack/nack. Public để test gọi trực tiếp. */
  async handle(msg: ConsumeMessage): Promise<ConsumeOutcome> {
    const outcome = await this.process(msg);
    if (!this.channel) return outcome;
    if (outcome === 'dead-lettered') this.channel.nack(msg, false, false);
    else if (outcome === 'requeued') this.channel.nack(msg, false, true);
    else this.channel.ack(msg);
    return outcome;
  }

  private async process(msg: ConsumeMessage): Promise<ConsumeOutcome> {
    let event: DomainEvent;
    try {
      event = JSON.parse(msg.content.toString('utf8')) as DomainEvent;
    } catch {
      this.logger.error(
        { routingKey: msg.fields.routingKey, messageId: msg.properties.messageId },
        'Message không phải JSON, chuyển vào DLQ',
      );
      return 'dead-lettered';
    }
    const invalid = checkEnvelope(event);
    if (invalid) {
      this.logger.error(
        { routingKey: msg.fields.routingKey, reason: invalid },
        'Envelope không hợp lệ, chuyển vào DLQ',
      );
      return 'dead-lettered';
    }

    const handler = this.registry.get(event.eventType);
    if (!handler) {
      this.logger.debug({ eventType: event.eventType }, 'Không có handler, bỏ qua');
      return 'ignored';
    }

    // Mở context CLS với correlationId của event: log của handler và event phát tiếp theo
    // (outbox.add) mang cùng correlationId với request gốc
    return this.cls.run(async () => {
      this.cls.set(CLS_ID, event.correlationId);
      const meta = { eventId: event.eventId, eventType: event.eventType };
      for (let attempt = 0; ; attempt++) {
        try {
          const duplicate = await this.dataSource.transaction(async (manager) => {
            const inserted: unknown[] = await manager.query(
              `INSERT INTO processed_events (event_id, event_type) VALUES ($1, $2)
               ON CONFLICT (event_id) DO NOTHING
               RETURNING event_id`,
              [event.eventId, event.eventType],
            );
            if (inserted.length === 0) return true;
            await handler(event, manager);
            return false;
          });
          if (duplicate) {
            this.logger.info(meta, 'Event đã xử lý trước đó, bỏ qua');
            return 'duplicate';
          }
          this.logger.info(meta, 'Đã xử lý event');
          return 'processed';
        } catch (err) {
          const giveUp = err instanceof NonRetryableEventError || attempt >= this.maxRetries;
          if (giveUp) {
            this.logger.error(
              { ...meta, err, attempts: attempt + 1 },
              'Xử lý event thất bại, chuyển vào DLQ',
            );
            return 'dead-lettered';
          }
          if (this.stopping) {
            // Đang tắt: trả message về queue để instance khác (hoặc lần chạy sau) xử lý
            this.logger.warn({ ...meta, err }, 'Đang tắt, trả event về queue');
            return 'requeued';
          }
          this.logger.warn({ ...meta, err, attempt: attempt + 1 }, 'Xử lý event lỗi, sẽ thử lại');
          await sleep(retryDelayMs(attempt));
        }
      }
    });
  }

  private track(work: Promise<unknown>): void {
    this.inFlight.add(work);
    void work
      .catch((err) => this.logger.error({ err }, 'Lỗi không mong đợi khi xử lý message'))
      .finally(() => this.inFlight.delete(work));
  }
}
