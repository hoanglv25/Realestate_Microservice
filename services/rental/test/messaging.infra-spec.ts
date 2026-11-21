import { Injectable, OnModuleInit } from '@nestjs/common';
import amqplib, { ChannelModel, Channel } from 'amqplib';
import { randomUUID } from 'node:crypto';
import { Client } from 'pg';
import { DataSource } from 'typeorm';
import { buildDomainEvent, DomainEvent } from '../src/messaging/domain-event';
import { EventHandlerRegistry } from '../src/messaging/event-handler.registry';
import { OutboxRelay } from '../src/messaging/outbox.relay';
import { OutboxService } from '../src/messaging/outbox.service';
import { expectEventMatchesContract } from './helpers/contracts';
import type { TestApp } from './helpers/create-test-app';
import { INFRA_TEST_SCHEMA, waitFor } from './helpers/infra';

/**
 * Luồng messaging với Postgres + RabbitMQ THẬT (pnpm infra:up, rồi pnpm test:infra).
 *
 * Test tự tạo queue tạm `template.infra-test.<ngẫu nhiên>` bind với routing key `templatetest.*`
 * (kèm DLQ riêng) và xóa ở cuối, nên không ảnh hưởng queue thật của các service.
 * Đây cũng là MẪU cách một service publish và consume event (xem TestEventHandlers bên dưới).
 */
const EXCHANGE = 'domain.events';
const DLX = 'domain.events.dlx';
const queue = `template.infra-test.${randomUUID().slice(0, 8)}`;
const dlq = `${queue}.dlq`;

/** Handler mẫu: module nghiệp vụ đăng ký handler trong onModuleInit. */
@Injectable()
class TestEventHandlers implements OnModuleInit {
  readonly received: DomainEvent<object>[] = [];
  failCalls = 0;

  constructor(private readonly events: EventHandlerRegistry) {}

  onModuleInit(): void {
    this.events.on('templatetest.ok', async (event, manager) => {
      // Ghi dữ liệu qua `manager` để cùng transaction với inbox
      await manager.query('SELECT 1');
      this.received.push(event);
    });
    this.events.on('templatetest.fail', async () => {
      this.failCalls += 1;
      throw new Error('handler lỗi có chủ đích');
    });
  }
}

describe('Messaging với RabbitMQ + Postgres thật', () => {
  let t: TestApp;
  let amqp: ChannelModel;
  let channel: Channel;
  let pg: Client;
  let handlers: TestEventHandlers;
  let dataSource: DataSource;
  let outbox: OutboxService;

  const publishRaw = (event: object, routingKey: string) =>
    channel.publish(EXCHANGE, routingKey, Buffer.from(JSON.stringify(event)), {
      persistent: true,
      contentType: 'application/json',
    });

  beforeAll(async () => {
    // Schema riêng cho test (search_path đã trỏ vào đây trong DATABASE_URL)
    pg = new Client({ connectionString: process.env.DATABASE_URL });
    await pg.connect();
    await pg.query(`DROP SCHEMA IF EXISTS ${INFRA_TEST_SCHEMA} CASCADE`);
    await pg.query(`CREATE SCHEMA ${INFRA_TEST_SCHEMA}`);

    // Queue tạm + DLQ, cùng kiểu với queue thật trong definitions.json
    amqp = await amqplib.connect(process.env.RABBITMQ_URL as string);
    channel = await amqp.createChannel();
    await channel.assertQueue(dlq, { durable: false });
    await channel.bindQueue(dlq, DLX, queue);
    await channel.assertQueue(queue, {
      durable: false,
      arguments: { 'x-dead-letter-exchange': DLX, 'x-dead-letter-routing-key': queue },
    });
    await channel.bindQueue(queue, EXCHANGE, 'templatetest.*');

    process.env.RABBITMQ_QUEUE = queue;
    process.env.OUTBOX_POLL_INTERVAL_MS = '200';
    process.env.RABBITMQ_MAX_RETRIES = '1';

    const { createTestApp } = await import('./helpers/create-test-app');
    t = await createTestApp([], [TestEventHandlers]);
    dataSource = t.app.get(DataSource);
    await dataSource.runMigrations();
    handlers = t.app.get(TestEventHandlers);
    outbox = t.app.get(OutboxService);
  });

  afterAll(async () => {
    await t?.app.close();
    await channel?.deleteQueue(queue).catch(() => undefined);
    await channel?.deleteQueue(dlq).catch(() => undefined);
    await amqp?.close().catch(() => undefined);
    await pg?.query(`DROP SCHEMA IF EXISTS ${INFRA_TEST_SCHEMA} CASCADE`).catch(() => undefined);
    await pg?.end();
    for (const name of ['RABBITMQ_QUEUE', 'OUTBOX_POLL_INTERVAL_MS', 'RABBITMQ_MAX_RETRIES']) {
      delete process.env[name];
    }
  });

  it('/health có rabbitmq và db đều "up"', async () => {
    await waitFor(async () => (await t.http().get('/health')).status === 200, '/health 200');
    const res = await t.http().get('/health');
    expect(res.body.checks).toEqual({ db: 'up', rabbitmq: 'up' });
  });

  it('outbox -> relay -> RabbitMQ -> consumer -> handler, giữ nguyên correlationId', async () => {
    const event = await dataSource.transaction((manager) =>
      outbox.add(manager, 'templatetest.ok', { note: 'xin chào' }),
    );
    const got = await waitFor(
      () => handlers.received.find((e) => e.eventId === event.eventId),
      'handler nhận event',
    );
    expect(got).toMatchObject({ eventType: 'templatetest.ok', payload: { note: 'xin chào' } });
    expect(got.correlationId).toBe(event.correlationId);
    expect(got.producer).toBe('template-nest-test');

    const [row] = await pg
      .query(
        `SELECT published_at, attempts FROM ${INFRA_TEST_SCHEMA}.outbox_events WHERE id = $1`,
        [event.eventId],
      )
      .then((r) => r.rows);
    expect(row.published_at).not.toBeNull();
    expect(row.attempts).toBe(1);
    const inbox = await pg.query(
      `SELECT 1 FROM ${INFRA_TEST_SCHEMA}.processed_events WHERE event_id = $1`,
      [event.eventId],
    );
    expect(inbox.rowCount).toBe(1);
  });

  it('transaction rollback thì event KHÔNG vào outbox và không được gửi', async () => {
    let eventId = '';
    await expect(
      dataSource.transaction(async (manager) => {
        eventId = (await outbox.add(manager, 'templatetest.ok', { note: 'rollback' })).eventId;
        throw new Error('nghiệp vụ lỗi sau khi ghi outbox');
      }),
    ).rejects.toThrow('nghiệp vụ lỗi');
    const r = await pg.query(`SELECT 1 FROM ${INFRA_TEST_SCHEMA}.outbox_events WHERE id = $1`, [
      eventId,
    ]);
    expect(r.rowCount).toBe(0);
    await t.app.get(OutboxRelay).relayOnce();
    expect(handlers.received.some((e) => e.eventId === eventId)).toBe(false);
  });

  it('gọi outbox.add ngoài transaction -> lỗi rõ ràng', async () => {
    await expect(outbox.add(dataSource.manager, 'templatetest.ok', {})).rejects.toThrow(
      /bên trong transaction/,
    );
  });

  it('cùng một event giao hai lần -> handler chỉ chạy một lần', async () => {
    const event = buildDomainEvent({
      eventType: 'templatetest.ok',
      payload: { note: 'trùng' },
      producer: 'test',
    });
    publishRaw(event, event.eventType);
    publishRaw(event, event.eventType);
    await waitFor(
      () => handlers.received.some((e) => e.eventId === event.eventId),
      'handler nhận event',
    );
    // Chờ message thứ hai được ack (queue rỗng) rồi mới đếm
    await waitFor(async () => (await channel.checkQueue(queue)).messageCount === 0, 'queue rỗng');
    await new Promise((r) => setTimeout(r, 300));
    expect(handlers.received.filter((e) => e.eventId === event.eventId)).toHaveLength(1);
  });

  it('handler lỗi mãi -> thử 1 + RABBITMQ_MAX_RETRIES lần rồi vào DLQ (có header x-death)', async () => {
    const event = buildDomainEvent({
      eventType: 'templatetest.fail',
      payload: {},
      producer: 'test',
    });
    publishRaw(event, event.eventType);
    const dead = await waitFor(async () => {
      const m = await channel.get(dlq, { noAck: true });
      return m || undefined;
    }, 'message trong DLQ');
    expect(JSON.parse(dead.content.toString()).eventId).toBe(event.eventId);
    expect(dead.properties.headers?.['x-death']?.[0]).toMatchObject({ queue, reason: 'rejected' });
    expect(handlers.failCalls).toBe(2);
  });

  it('JSON hỏng -> vào DLQ ngay; event không có handler -> ack và bỏ qua', async () => {
    channel.publish(EXCHANGE, 'templatetest.broken', Buffer.from('{không phải json'));
    const dead = await waitFor(async () => {
      const m = await channel.get(dlq, { noAck: true });
      return m || undefined;
    }, 'JSON hỏng trong DLQ');
    expect(dead.content.toString()).toBe('{không phải json');

    const unknown = buildDomainEvent({
      eventType: 'templatetest.other',
      payload: {},
      producer: 'test',
    });
    publishRaw(unknown, unknown.eventType);
    await waitFor(async () => (await channel.checkQueue(queue)).messageCount === 0, 'queue rỗng');
    expect(await channel.get(dlq, { noAck: true })).toBe(false);
  });

  it('expectEventMatchesContract: event do OutboxService dựng khớp contract rental.deposit-created', async () => {
    const payload = {
      depositId: randomUUID(),
      listingId: randomUUID(),
      tenantId: randomUUID(),
      ownerId: randomUUID(),
      amountVnd: 3000000,
      expiresAt: new Date().toISOString(),
    };
    // Rollback để không thực sự gửi rental.deposit-created lên exchange
    const event = await dataSource
      .transaction(async (manager) => {
        const e = await outbox.add(manager, 'rental.deposit-created', payload);
        throw Object.assign(new Error('rollback'), { event: e });
      })
      .catch((err: { event: DomainEvent }) => err.event);
    expect(() => expectEventMatchesContract({ ...event, producer: 'rental' })).not.toThrow();
    expect(() =>
      expectEventMatchesContract({
        ...event,
        producer: 'rental',
        payload: { ...payload, amountVnd: '3000000' },
      }),
    ).toThrow(/amountVnd/);
  });
});
