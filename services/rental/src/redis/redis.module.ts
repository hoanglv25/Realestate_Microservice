import { Global, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Redis from 'ioredis';
import { EnvVars } from '../config/env.validation';
import { REDIS_CLIENT, RedisService } from './redis.service';

/**
 * TÙY CHỌN: chỉ được nạp khi có REDIS_URL (xem app.module.ts + config/feature-flags.ts).
 * Ví dụ: REDIS_URL=redis://:change_me_redis@localhost:6379
 */
@Global()
@Module({
  providers: [
    {
      provide: REDIS_CLIENT,
      inject: [ConfigService],
      useFactory: (config: ConfigService<EnvVars, true>) =>
        new Redis(config.get('REDIS_URL', { infer: true }), {
          // Lỗi nhanh thay vì treo request khi Redis chết (health check cũng cần nhanh)
          maxRetriesPerRequest: 1,
          retryStrategy: (times) => Math.min(times * 200, 2000),
        }),
    },
    RedisService,
  ],
  exports: [RedisService],
})
export class RedisModule {}
