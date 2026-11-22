import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { validateEnv } from './env.validation';

/**
 * Cấu hình toàn cục: validate process.env bằng Joi (env.validation.ts).
 * File .env do env.bootstrap.ts nạp (main.ts) nên ConfigModule bỏ qua file .env; nhờ vậy test
 * e2e không vô tình đọc .env cục bộ của lập trình viên.
 * Dùng `ConfigService<EnvVars, true>` để lấy giá trị có kiểu.
 */
@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      cache: false,
      ignoreEnvFile: true,
      validate: validateEnv,
    }),
  ],
})
export class AppConfigModule {}
