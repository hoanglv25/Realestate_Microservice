import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { join } from 'node:path';
import { EnvVars } from '../config/env.validation';
import { DatabaseHealthRegistrar } from './database.health';

/**
 * TÙY CHỌN: chỉ được nạp khi có DATABASE_URL (xem app.module.ts + config/feature-flags.ts).
 * Ví dụ: DATABASE_URL=postgres://identity_user:change_me_identity@localhost:5433/identity_db
 *
 * - synchronize=false: schema chỉ đổi qua migration (`pnpm migration:generate|run|revert`).
 * - Đóng kết nối khi SIGTERM do TypeOrmModule tự xử lý (enableShutdownHooks trong main.ts).
 * - Module nghiệp vụ dùng DB tự đăng ký entity của mình: `TypeOrmModule.forFeature([Entity])`
 *   (entity được tự nạp nhờ autoLoadEntities). Module này KHÔNG import entity nào, nên xóa
 *   entity/migration mẫu trong thư mục database/ không làm vỡ build.
 */
@Module({
  imports: [
    TypeOrmModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService<EnvVars, true>) => ({
        type: 'postgres' as const,
        url: config.get('DATABASE_URL', { infer: true }),
        autoLoadEntities: true,
        synchronize: false,
        migrations: [join(__dirname, 'migrations', '*.{ts,js}')],
        migrationsRun: false,
        logging: ['error', 'warn'] as Array<'error' | 'warn'>,
        // UUID dùng gen_random_uuid() của PostgreSQL (không cần extension uuid-ossp)
        uuidExtension: 'pgcrypto' as const,
        retryAttempts: 5,
        retryDelay: 2000,
        extra: { max: 10, connectionTimeoutMillis: 3000 },
      }),
    }),
  ],
  providers: [DatabaseHealthRegistrar],
})
export class DatabaseModule {}
