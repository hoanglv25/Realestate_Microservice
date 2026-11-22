import { Injectable, OnApplicationShutdown, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import amqp, { AmqpConnectionManager, ChannelWrapper } from 'amqp-connection-manager';
import type { ConfirmChannel } from 'amqplib';
import { PinoLogger } from 'nestjs-pino';
import { EnvVars } from '../config/env.validation';
import { HealthRegistry } from '../health/health.registry';

/**
 * Một kết nối RabbitMQ cho cả service, tự kết nối lại khi broker khởi động lại.
 * - `publisher`: confirm channel, `publish()` chỉ resolve khi broker xác nhận đã nhận message.
 * - Đăng ký health check 'rabbitmq'.
 * - Lúc kết nối kiểm tra exchange tồn tại (topology do infra/rabbitmq/definitions.json tạo,
 *   service KHÔNG tự khai báo exchange/queue để không lệch với cấu hình chung).
 */
@Injectable()
export class RabbitMqConnection implements OnModuleInit, OnApplicationShutdown {
  readonly manager: AmqpConnectionManager;
  readonly publisher: ChannelWrapper;
  readonly exchange: string;

  constructor(
    config: ConfigService<EnvVars, true>,
    private readonly registry: HealthRegistry,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(RabbitMqConnection.name);
    this.exchange = config.get('RABBITMQ_EXCHANGE', { infer: true });
    this.manager = amqp.connect([config.get('RABBITMQ_URL', { infer: true })], {
      heartbeatIntervalInSeconds: 10,
      reconnectTimeInSeconds: 2,
      connectionOptions: { clientProperties: { connection_name: config.get('SERVICE_NAME') } },
    });
    this.manager.on('connect', () => this.logger.info('Đã kết nối RabbitMQ'));
    this.manager.on('disconnect', ({ err }) =>
      this.logger.warn({ err }, 'Mất kết nối RabbitMQ, đang thử kết nối lại'),
    );
    this.manager.on('connectFailed', ({ err }) =>
      this.logger.warn({ err }, 'Không kết nối được RabbitMQ, sẽ thử lại'),
    );

    this.publisher = this.manager.createChannel({
      name: 'publisher',
      confirm: true,
      publishTimeout: 5000,
      setup: async (channel: ConfirmChannel) => {
        await channel.checkExchange(this.exchange);
      },
    });
    this.publisher.on('error', (err) =>
      this.logger.error(
        { err },
        `Exchange "${this.exchange}" không tồn tại hoặc lỗi kênh publish. Chạy pnpm infra:up ở thư mục gốc.`,
      ),
    );
  }

  onModuleInit(): void {
    this.registry.register('rabbitmq', async () => this.manager.isConnected());
  }

  /**
   * Đóng ở onApplicationShutdown (SAU onModuleDestroy), để OutboxRelay và EventConsumer kịp
   * dừng và ack/publish nốt trên kết nối còn sống.
   */
  async onApplicationShutdown(): Promise<void> {
    await this.publisher.close().catch(() => undefined);
    await this.manager.close().catch(() => undefined);
  }
}
