import 'reflect-metadata';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { DataSource } from 'typeorm';

// DataSource dành riêng cho TypeORM CLI (`pnpm migration:*`), tách khỏi NestJS.
// Đọc DATABASE_URL từ môi trường hoặc file .env trong thư mục service.
if (existsSync('.env')) {
  process.loadEnvFile('.env');
}

export default new DataSource({
  type: 'postgres',
  url: process.env.DATABASE_URL,
  // Entity của mọi module (database/entities, messaging/entities, ...)
  entities: [join(__dirname, '..', '**', '*.entity.{ts,js}')],
  migrations: [join(__dirname, 'migrations', '*.{ts,js}')],
  uuidExtension: 'pgcrypto',
});
