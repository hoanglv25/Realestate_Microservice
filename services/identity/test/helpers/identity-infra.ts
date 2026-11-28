import Redis from 'ioredis';
import { generateKeyPairSync, randomUUID } from 'node:crypto';
import { Client } from 'pg';
import { DataSource } from 'typeorm';
import { MAIL_TRANSPORT } from '../../src/identity/services/mail.service';
import type { TestApp } from './create-test-app';
import { INFRA_TEST_SCHEMA, readRootEnv } from './infra';
import { captureTransport, clearCapturedMails } from './mail-capture';

/**
 * Dựng identity thật (Postgres schema riêng, Redis tiền tố ngẫu nhiên, RabbitMQ không relay) cho test T2.5.
 * Email không đi qua SMTP: `MAIL_TRANSPORT` được thay bằng `captureTransport` (`mail-capture.ts`, C27);
 * `overrides` của từng test đặt sau nên ghi đè được.
 * Dùng lại cùng cách dựng với auth.infra-spec.ts; file mới dùng helper này thay vì chép ~60 dòng khởi tạo.
 */
export interface IdentityInfra {
  t: TestApp;
  pg: Client;
  redis: Redis;
  ds: DataSource;
  /** Mọi câu SQL TypeORM chạy từ lúc gọi `queries.length = 0` (không tính START TRANSACTION, COMMIT, ROLLBACK). */
  queries: string[];
  redisPrefix: string;
  close(): Promise<void>;
}

export interface StartOptions {
  /** Biến môi trường thêm khi dựng app (ví dụ GOOGLE_CLIENT_ID, OTP_RESEND_COOLDOWN_SECONDS). */
  env?: Record<string, string>;
  /** Thay provider của app (ví dụ bộ kiểm ID token Google giả). */
  overrides?: Array<{ token: unknown; value: unknown }>;
}

const ENV_NAMES = [
  'REDIS_URL',
  'REFRESH_TOKEN_REDIS_PREFIX',
  'JWT_PRIVATE_KEY',
  'JWT_PUBLIC_KEY',
  'JWT_ISSUER',
  'OUTBOX_RELAY_ENABLED',
];

export async function startIdentityInfra(options: StartOptions = {}): Promise<IdentityInfra> {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
  const redisPrefix = `identity-test:${randomUUID().slice(0, 8)}:`;
  const root = readRootEnv();
  const redisUrl = `redis://:${encodeURIComponent(root.REDIS_PASSWORD as string)}@localhost:${root.REDIS_PORT ?? '6379'}`;

  const pg = new Client({ connectionString: process.env.DATABASE_URL });
  await pg.connect();
  await pg.query(`DROP SCHEMA IF EXISTS ${INFRA_TEST_SCHEMA} CASCADE`);
  await pg.query(`CREATE SCHEMA ${INFRA_TEST_SCHEMA}`);
  const redis = new Redis(redisUrl);

  const extraNames = Object.keys(options.env ?? {});
  Object.assign(process.env, {
    REDIS_URL: redisUrl,
    REFRESH_TOKEN_REDIS_PREFIX: redisPrefix,
    JWT_PRIVATE_KEY: privateKey,
    JWT_PUBLIC_KEY: publicKey,
    JWT_ISSUER: 'realestate-identity-test',
    OUTBOX_RELAY_ENABLED: 'false',
    ...options.env,
  });

  const { createTestApp } = await import('./create-test-app');
  const t = await createTestApp([], [], {
    swagger: false,
    overrides: [{ token: MAIL_TRANSPORT, value: captureTransport }, ...(options.overrides ?? [])],
  });
  const ds = t.app.get(DataSource);
  await ds.runMigrations();

  const queries: string[] = [];
  const noop = () => undefined;
  (ds as unknown as { logger: unknown }).logger = {
    logQuery: (q: string) => {
      if (!/^(START TRANSACTION|COMMIT|ROLLBACK)$/i.test(q.trim())) queries.push(q);
    },
    logQueryError: noop,
    logQuerySlow: noop,
    logSchemaBuild: noop,
    logMigration: noop,
    log: noop,
  };

  return {
    t,
    pg,
    redis,
    ds,
    queries,
    redisPrefix,
    async close() {
      await t.app.close();
      clearCapturedMails();
      const keys = await redis.keys(`${redisPrefix}*`);
      if (keys.length > 0) await redis.del(...keys);
      await redis.quit();
      await pg.query(`DROP SCHEMA IF EXISTS ${INFRA_TEST_SCHEMA} CASCADE`).catch(() => undefined);
      await pg.end();
      for (const name of [...ENV_NAMES, ...extraNames]) delete process.env[name];
    },
  };
}
