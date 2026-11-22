import { Global, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { APP_GUARD } from '@nestjs/core';
import { JwtModule } from '@nestjs/jwt';
import { EnvVars } from '../../config/env.validation';
import { JWT_VERIFY_CONFIG, resolveJwtVerifyConfig } from './jwt.config';
import { JwtAuthGuard } from './jwt.guard';
import { JwtTokenVerifier } from './jwt-token.verifier';
import { RolesGuard } from './roles.guard';

/**
 * Đăng ký guard toàn cục theo thứ tự: JwtAuthGuard (xác thực) rồi RolesGuard (phân quyền).
 * Dùng APP_GUARD (không phải app.useGlobalGuards) để test e2e từ AppModule chạy đúng như thật.
 * JwtTokenVerifier được export để guard riêng của service (ví dụ AccessGuard của gateway) dùng chung.
 */
@Global()
@Module({
  imports: [JwtModule.register({})],
  exports: [JwtTokenVerifier],
  providers: [
    JwtTokenVerifier,
    {
      provide: JWT_VERIFY_CONFIG,
      inject: [ConfigService],
      useFactory: (config: ConfigService<EnvVars, true>) =>
        resolveJwtVerifyConfig({
          JWT_PUBLIC_KEY: config.get('JWT_PUBLIC_KEY', { infer: true }),
          JWT_PUBLIC_KEY_PATH: config.get('JWT_PUBLIC_KEY_PATH', { infer: true }),
          JWT_SECRET: config.get('JWT_SECRET', { infer: true }),
          JWT_ISSUER: config.get('JWT_ISSUER', { infer: true }),
        }),
    },
    { provide: APP_GUARD, useClass: JwtAuthGuard },
    { provide: APP_GUARD, useClass: RolesGuard },
  ],
})
export class AuthModule {}
