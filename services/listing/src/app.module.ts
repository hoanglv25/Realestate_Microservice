import { Module } from '@nestjs/common';
import { APP_FILTER, APP_INTERCEPTOR, APP_PIPE } from '@nestjs/core';
import { ClsModule } from 'nestjs-cls';
import { AllExceptionsFilter } from './common/errors/all-exceptions.filter';
import { AuthModule } from './common/auth/auth.module';
import { createValidationPipe } from './common/errors/validation-pipe.factory';
import { ShutdownLoggerService } from './common/lifecycle/shutdown-logger.service';
import { InternalHttpModule } from './common/http/internal-http.module';
import { AppLoggerModule } from './common/logging/logger.module';
import { ResponseEnvelopeInterceptor } from './common/response/response-envelope.interceptor';
import { AppConfigModule } from './config/config.module';
import {
  isDatabaseEnabled,
  isListingEnabled,
  isMessagingEnabled,
  isRedisEnabled,
  isStorageEnabled,
} from './config/feature-flags';
import { DatabaseModule } from './database/database.module';
import { HealthModule } from './health/health.module';
import { ListingModule } from './listing/listing.module';
import { MessagingModule } from './messaging/messaging.module';
import { RedisModule } from './redis/redis.module';
import { StorageModule } from './storage/storage.module';

/**
 * Module gốc.
 *
 * Module tùy chọn chỉ bật khi có biến môi trường tương ứng:
 *   DATABASE_URL -> DatabaseModule (TypeORM + PostgreSQL)
 *   REDIS_URL    -> RedisModule (ioredis)
 *   RABBITMQ_URL -> MessagingModule (outbox, inbox, consumer; bắt buộc kèm DATABASE_URL)
 *   S3_ENDPOINT  -> StorageModule (S3: presigned URL; bucket tạo sẵn, decisions/0016)
 *   đủ DB + S3   -> ListingModule (sản phẩm, duyệt, ảnh)
 * Health check (/health) tự thêm `db`/`redis`/`rabbitmq`/`s3` vào `checks` khi module tương ứng được bật.
 *
 * Filter và pipe đăng ký qua APP_FILTER/APP_PIPE (không dùng app.useGlobalX trong main.ts)
 * để test e2e tạo app từ AppModule cũng chạy đúng cùng hành vi.
 */
@Module({
  imports: [
    AppConfigModule,
    ClsModule.forRoot({ global: true }),
    AppLoggerModule,
    AuthModule,
    InternalHttpModule,
    HealthModule,
    ...(isDatabaseEnabled() ? [DatabaseModule] : []),
    ...(isRedisEnabled() ? [RedisModule] : []),
    ...(isMessagingEnabled() ? [MessagingModule] : []),
    ...(isStorageEnabled() ? [StorageModule] : []),
    // Nghiệp vụ listing: nạp SAU DatabaseModule/StorageModule mà nó dùng
    ...(isListingEnabled() ? [ListingModule] : []),
  ],
  providers: [
    ShutdownLoggerService,
    { provide: APP_FILTER, useClass: AllExceptionsFilter },
    // Bọc mọi response thành công thành { data, meta } (lỗi do AllExceptionsFilter dựng { error, meta })
    { provide: APP_INTERCEPTOR, useClass: ResponseEnvelopeInterceptor },
    { provide: APP_PIPE, useFactory: createValidationPipe },
  ],
})
export class AppModule {}
