import { INestApplication, Provider, Type } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AppModule } from '../../src/app.module';
import { configureApp } from '../../src/app.setup';
import { LOG_STREAM } from '../../src/common/logging/logger.module';
import { setupSwagger } from '../../src/swagger.setup';

export interface TestApp {
  app: INestApplication;
  /** Mọi dòng log service ghi ra (mỗi phần tử là một dòng JSON). */
  logs: string[];
  http: () => ReturnType<typeof request>;
  /** Log đã parse JSON. */
  logRecords: () => Array<Record<string, unknown>>;
}

/**
 * Tạo app test giống hệt lúc chạy thật (AppModule + configureApp), thay đích log bằng bộ nhớ
 * để test kiểm tra được nội dung log. `controllers`/`providers` để thêm thành phần chỉ dùng trong test.
 */
export async function createTestApp(
  controllers: Type[] = [],
  providers: Provider[] = [],
  options: {
    swagger?: boolean;
    /** Thay provider có sẵn bằng giá trị giả (ví dụ lưu chứng từ không cần S3 thật, T3.6). */
    overrides?: Array<{ provide: unknown; useValue: unknown }>;
  } = {},
): Promise<TestApp> {
  const logs: string[] = [];
  const stream = {
    write: (chunk: string) => {
      for (const line of chunk.split('\n')) {
        if (line.trim()) logs.push(line.trim());
      }
    },
  };

  let builder = Test.createTestingModule({
    imports: [AppModule],
    controllers,
    providers,
  })
    .overrideProvider(LOG_STREAM)
    .useValue(stream);
  for (const o of options.overrides ?? []) {
    builder = builder.overrideProvider(o.provide).useValue(o.useValue);
  }
  const moduleRef = await builder.compile();

  const app = moduleRef.createNestApplication({ logger: false });
  configureApp(app);
  if (options.swagger) setupSwagger(app); // phải gọi TRƯỚC app.init()
  await app.init();

  return {
    app,
    logs,
    http: () => request(app.getHttpServer()),
    logRecords: () => logs.map((l) => JSON.parse(l) as Record<string, unknown>),
  };
}

export const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
