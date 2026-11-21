import type { ConsumeMessage } from 'amqplib';
import type { ConfigService } from '@nestjs/config';
import type { ClsService } from 'nestjs-cls';
import type { PinoLogger } from 'nestjs-pino';
import type { DataSource } from 'typeorm';
import type { EnvVars } from '../config/env.validation';
import { buildDomainEvent } from './domain-event';
import { EventConsumer, retryDelayMs } from './event.consumer';
import { EventHandlerRegistry, NonRetryableEventError } from './event-handler.registry';
import type { RabbitMqConnection } from './rabbitmq.connection';

/**
 * Test logic xử lý message của EventConsumer với DB giả (không cần RabbitMQ/Postgres).
 * Luồng thật với hạ tầng xem test/messaging.infra-spec.ts.
 */
function setup(maxRetries = 2) {
  const processed = new Set<string>();
  // DB giả: transaction() gọi callback với manager giả; rollback = bỏ eventId vừa ghi
  const dataSource = {
    transaction: async <T>(work: (m: unknown) => Promise<T>): Promise<T> => {
      const written: string[] = [];
      const manager = {
        query: async (_sql: string, params: string[]) => {
          if (processed.has(params[0])) return [];
          processed.add(params[0]);
          written.push(params[0]);
          return [{ event_id: params[0] }];
        },
      };
      try {
        return await work(manager);
      } catch (err) {
        written.forEach((id) => processed.delete(id));
        throw err;
      }
    },
  } as unknown as DataSource;

  const env: Partial<EnvVars> = { RABBITMQ_PREFETCH: 10, RABBITMQ_MAX_RETRIES: maxRetries };
  const config = { get: (key: keyof EnvVars) => env[key] } as unknown as ConfigService<
    EnvVars,
    true
  >;
  const cls = { run: (fn: () => unknown) => fn(), set: () => undefined } as unknown as ClsService;
  const noop = () => undefined;
  const logger = {
    setContext: noop,
    info: noop,
    warn: noop,
    error: noop,
    debug: noop,
  } as unknown as PinoLogger;
  const registry = new EventHandlerRegistry();
  const consumer = new EventConsumer(
    config,
    {} as RabbitMqConnection,
    registry,
    dataSource,
    cls,
    logger,
  );
  return { consumer, registry, processed };
}

const message = (body: unknown): ConsumeMessage =>
  ({
    content: Buffer.from(typeof body === 'string' ? body : JSON.stringify(body)),
    fields: { routingKey: 'payment.deposited' },
    properties: { messageId: 'm1' },
  }) as unknown as ConsumeMessage;

const deposited = () =>
  buildDomainEvent({ eventType: 'payment.deposited', payload: { amount: 1 }, producer: 'payment' });

describe('EventConsumer.handle', () => {
  it('JSON hỏng hoặc envelope sai -> DLQ', async () => {
    const { consumer } = setup();
    await expect(consumer.handle(message('{không phải json'))).resolves.toBe('dead-lettered');
    await expect(consumer.handle(message({ eventType: 'x' }))).resolves.toBe('dead-lettered');
  });

  it('không có handler -> ignored, không ghi inbox', async () => {
    const { consumer, processed } = setup();
    await expect(consumer.handle(message(deposited()))).resolves.toBe('ignored');
    expect(processed.size).toBe(0);
  });

  it('xử lý xong ghi inbox; giao lại lần hai -> duplicate, handler không chạy lại', async () => {
    const { consumer, registry, processed } = setup();
    const handler = jest.fn().mockResolvedValue(undefined);
    registry.on('payment.deposited', handler);
    const event = deposited();

    await expect(consumer.handle(message(event))).resolves.toBe('processed');
    await expect(consumer.handle(message(event))).resolves.toBe('duplicate');
    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler.mock.calls[0][0]).toMatchObject({
      eventId: event.eventId,
      payload: { amount: 1 },
    });
    expect(processed.has(event.eventId)).toBe(true);
  });

  it('lỗi tạm thời -> thử lại, lần sau thành công -> processed', async () => {
    const { consumer, registry } = setup(2);
    const handler = jest
      .fn()
      .mockRejectedValueOnce(new Error('DB timeout'))
      .mockResolvedValue(undefined);
    registry.on('payment.deposited', handler);
    await expect(consumer.handle(message(deposited()))).resolves.toBe('processed');
    expect(handler).toHaveBeenCalledTimes(2);
  });

  it('lỗi mãi -> thử đủ 1 + RABBITMQ_MAX_RETRIES lần rồi DLQ; inbox được rollback', async () => {
    const { consumer, registry, processed } = setup(2);
    const handler = jest.fn().mockRejectedValue(new Error('hỏng'));
    registry.on('payment.deposited', handler);
    await expect(consumer.handle(message(deposited()))).resolves.toBe('dead-lettered');
    expect(handler).toHaveBeenCalledTimes(3);
    expect(processed.size).toBe(0);
  });

  it('NonRetryableEventError -> DLQ ngay, không thử lại', async () => {
    const { consumer, registry } = setup(5);
    const handler = jest.fn().mockRejectedValue(new NonRetryableEventError('sai nghiệp vụ'));
    registry.on('payment.deposited', handler);
    await expect(consumer.handle(message(deposited()))).resolves.toBe('dead-lettered');
    expect(handler).toHaveBeenCalledTimes(1);
  });
});

describe('EventHandlerRegistry', () => {
  it('không cho đăng ký hai handler cho cùng một event', () => {
    const registry = new EventHandlerRegistry();
    registry.on('rental.expired', async () => undefined);
    expect(() => registry.on('rental.expired', async () => undefined)).toThrow(/rental.expired/);
  });
});

describe('retryDelayMs', () => {
  it('tăng gấp đôi, tối đa 5 giây', () => {
    expect([0, 1, 2, 3].map(retryDelayMs)).toEqual([200, 400, 800, 1600]);
    expect(retryDelayMs(10)).toBe(5000);
  });
});
