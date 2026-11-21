import '../config/env.bootstrap'; // PHẢI đứng đầu: nạp + validate env
import { NestFactory } from '@nestjs/core';
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { AppModule } from '../app.module';
import { configureApp } from '../app.setup';
import { buildOpenApiDocument } from '../swagger.setup';

/**
 * `pnpm openapi:export`: xuất ./openapi.json để so với contracts/openapi/<service>.yaml
 * (ví dụ `npx openapi-diff` hoặc so sánh thủ công). Không cần chạy server; nếu .env bật
 * DATABASE_URL/REDIS_URL thì app sẽ cố kết nối, bỏ comment hai biến này nếu chỉ cần xuất tài liệu.
 */
async function main(): Promise<void> {
  const app = await NestFactory.create(AppModule, { logger: false, abortOnError: false });
  configureApp(app);
  await app.init();

  const file = resolve(process.cwd(), 'openapi.json');
  writeFileSync(file, `${JSON.stringify(buildOpenApiDocument(app), null, 2)}\n`, 'utf8');
  console.log(`Đã xuất ${file}`);
  await app.close();
}

main().catch((err: unknown) => {
  console.error('Xuất openapi.json thất bại:', err instanceof Error ? err.message : err);
  process.exit(1);
});
