import { ConfigService } from '@nestjs/config';
import { PinoLogger } from 'nestjs-pino';
import { DataSource } from 'typeorm';
import { EnvVars } from '../config/env.validation';
import { OutboxRelay } from './outbox.relay';
import { RabbitMqConnection } from './rabbitmq.connection';

function createRelay(enabled: boolean) {
  const values: Partial<EnvVars> = {
    OUTBOX_POLL_INTERVAL_MS: 100,
    OUTBOX_BATCH_SIZE: 10,
    OUTBOX_RELAY_ENABLED: enabled,
  };
  const config = { get: (key: keyof EnvVars) => values[key] } as unknown as ConfigService<
    EnvVars,
    true
  >;
  const transaction = jest.fn().mockResolvedValue(0);
  const dataSource = { transaction } as unknown as DataSource;
  const connection = {
    manager: { isConnected: () => true },
  } as unknown as RabbitMqConnection;
  const logger = {
    setContext: jest.fn(),
    warn: jest.fn(),
    debug: jest.fn(),
  } as unknown as PinoLogger;
  return { relay: new OutboxRelay(config, dataSource, connection, logger), transaction };
}

describe('OutboxRelay — OUTBOX_RELAY_ENABLED (C18)', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  it('true: tự quét outbox theo chu kỳ', async () => {
    const { relay, transaction } = createRelay(true);
    relay.onApplicationBootstrap();
    await jest.advanceTimersByTimeAsync(350);
    expect(transaction).toHaveBeenCalled();
    await relay.onModuleDestroy();
  });

  it('false: không tự quét, event chỉ nằm trong outbox', async () => {
    const { relay, transaction } = createRelay(false);
    relay.onApplicationBootstrap();
    await jest.advanceTimersByTimeAsync(1000);
    expect(transaction).not.toHaveBeenCalled();
    await relay.onModuleDestroy();
  });

  it('false: relayOnce gọi tay vẫn chạy (test dùng để gửi chủ động)', async () => {
    const { relay, transaction } = createRelay(false);
    await relay.relayOnce();
    expect(transaction).toHaveBeenCalledTimes(1);
  });
});
