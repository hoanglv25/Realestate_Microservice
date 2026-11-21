import { Global, Module } from '@nestjs/common';
import { TerminusModule } from '@nestjs/terminus';
import { HealthController } from './health.controller';
import { HealthRegistry } from './health.registry';

/** Global để các module tùy chọn (Database, Redis...) inject HealthRegistry mà không cần import. */
@Global()
@Module({
  imports: [TerminusModule],
  controllers: [HealthController],
  providers: [HealthRegistry],
  exports: [HealthRegistry],
})
export class HealthModule {}
