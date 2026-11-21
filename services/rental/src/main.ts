import './config/env.bootstrap'; // PHẢI đứng đầu: nạp + validate env trước mọi thứ khác
import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import { Logger } from 'nestjs-pino';
import { AppModule } from './app.module';
import { configureApp } from './app.setup';
import { EnvVars } from './config/env.validation';
import { setupSwagger } from './swagger.setup';

async function bootstrap(): Promise<void> {
  // abortOnError=false: lỗi khởi động ném ra để ta tự in gọn và thoát, thay vì process.abort()
  // bufferLogs: giữ log khởi động của Nest cho tới khi pino sẵn sàng, để mọi dòng đều là JSON
  const app = await NestFactory.create(AppModule, { abortOnError: false, bufferLogs: true });
  app.useLogger(app.get(Logger));
  configureApp(app);

  const config = app.get<ConfigService<EnvVars, true>>(ConfigService);
  if (config.get('SWAGGER_ENABLED', { infer: true })) {
    setupSwagger(app); // Swagger UI: /api/docs
  }

  // Graceful shutdown: SIGTERM/SIGINT -> Nest gọi onModuleDestroy (đóng DB/Redis/RabbitMQ)
  app.enableShutdownHooks();

  await app.listen(config.get('PORT', { infer: true }), '0.0.0.0');
}

bootstrap().catch((err: unknown) => {
  console.error('Khởi động service thất bại:', err instanceof Error ? err.message : err);
  process.exit(1);
});
