import { Injectable, OnApplicationBootstrap, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PinoLogger } from 'nestjs-pino';
import { DataSource } from 'typeorm';
import { EnvVars } from '../config/env.validation';
import type { DomainEvent } from './domain-event';
import { RabbitMqConnection } from './rabbitmq.connection';

interface PendingRow {
  id: string;
  event_type: string;
  envelope: DomainEvent;
}

/**
 * Đọc outbox và publish lên exchange theo chu kỳ OUTBOX_POLL_INTERVAL_MS.
 * - `FOR UPDATE SKIP LOCKED`: chạy nhiều instance cùng lúc không gửi trùng một dòng.
 * - Chỉ đánh dấu `published_at` khi broker đã xác nhận (confirm channel).
 * - Lỗi ở một event thì dừng lô đó (giữ thứ tự), lần quét sau thử lại.
 * - Vẫn có thể gửi trùng trong ca hiếm (broker đã nhận nhưng DB chưa kịp ghi), nên consumer
 *   luôn chống trùng theo eventId (xem EventConsumer).
 */
@Injectable()
export class OutboxRelay implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly intervalMs: number;
  private readonly batchSize: number;
  private readonly enabled: boolean;
  private timer?: NodeJS.Timeout;
  private running?: Promise<unknown>;
  private stopped = false;

  constructor(
    config: ConfigService<EnvVars, true>,
    private readonly dataSource: DataSource,
    private readonly connection: RabbitMqConnection,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(OutboxRelay.name);
    this.intervalMs = config.get('OUTBOX_POLL_INTERVAL_MS', { infer: true });
    this.batchSize = config.get('OUTBOX_BATCH_SIZE', { infer: true });
    this.enabled = config.get('OUTBOX_RELAY_ENABLED', { infer: true });
  }

  onApplicationBootstrap(): void {
    // OUTBOX_RELAY_ENABLED=false: event vẫn được GHI vào outbox nhưng không tự gửi (dùng cho test)
    if (this.enabled) this.schedule();
  }

  /** Dừng quét và chờ lô đang gửi xong. Chạy ở onModuleDestroy, trước khi đóng DB và RabbitMQ. */
  async onModuleDestroy(): Promise<void> {
    this.stopped = true;
    clearTimeout(this.timer);
    await this.running;
  }

  /** Gửi một lô. Trả về số event đã gửi. Public để test gọi trực tiếp. */
  async relayOnce(): Promise<number> {
    if (!this.connection.manager.isConnected()) return 0;
    return this.dataSource.transaction(async (manager) => {
      const rows: PendingRow[] = await manager.query(
        `SELECT id, event_type, envelope FROM outbox_events
         WHERE published_at IS NULL
         ORDER BY created_at
         LIMIT $1
         FOR UPDATE SKIP LOCKED`,
        [this.batchSize],
      );
      let sent = 0;
      for (const row of rows) {
        try {
          await this.connection.publisher.publish(
            this.connection.exchange,
            row.event_type,
            Buffer.from(JSON.stringify(row.envelope)),
            {
              persistent: true,
              contentType: 'application/json',
              messageId: row.id,
              type: row.event_type,
              correlationId: row.envelope.correlationId,
              appId: row.envelope.producer,
            },
          );
          await manager.query(
            `UPDATE outbox_events SET published_at = now(), attempts = attempts + 1, last_error = NULL
             WHERE id = $1`,
            [row.id],
          );
          sent += 1;
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          await manager.query(
            `UPDATE outbox_events SET attempts = attempts + 1, last_error = $2 WHERE id = $1`,
            [row.id, message.slice(0, 1000)],
          );
          this.logger.warn(
            { err, eventId: row.id, eventType: row.event_type },
            'Publish event thất bại, sẽ thử lại',
          );
          break;
        }
      }
      if (sent > 0) this.logger.debug({ sent }, 'Đã publish event từ outbox');
      return sent;
    });
  }

  private schedule(): void {
    if (this.stopped) return;
    this.timer = setTimeout(() => {
      this.running = this.relayOnce()
        .catch((err) => this.logger.warn({ err }, 'Quét outbox lỗi (DB?), sẽ thử lại'))
        .finally(() => {
          this.running = undefined;
          this.schedule();
        });
    }, this.intervalMs);
  }
}
