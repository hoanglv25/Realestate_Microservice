import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ScheduleModule } from '@nestjs/schedule';
import { TypeOrmModule } from '@nestjs/typeorm';
import { EnvVars } from '../config/env.validation';
import { RedisService } from '../redis/redis.service';
import { RENTAL_CLIENT_CONFIG } from './clients/client-config';
import type { RentalClientConfig } from './clients/client-config';
import { ListingClient } from './clients/listing.client';
import { PaymentClient } from './clients/payment.client';
import { DepositsController } from './controllers/deposits.controller';
import { ViewingsController } from './controllers/viewings.controller';
import { Deposit } from './entities/deposit.entity';
import { SagaLog } from './entities/saga-log.entity';
import { Viewing } from './entities/viewing.entity';
import { PAYMENT_EVENTS_CONFIG, PaymentEventsHandler } from './events/payment-events.handler';
import type { PaymentEventsConfig } from './events/payment-events.handler';
import { HOLD_EXPIRY_CONFIG, HoldExpiryJob } from './jobs/hold-expiry.job';
import type { HoldExpiryConfig } from './jobs/hold-expiry.job';
import { SAGA_RECONCILE_CONFIG, SagaReconcileJob } from './jobs/saga-reconcile.job';
import type { SagaReconcileConfig } from './jobs/saga-reconcile.job';
import { ListingLock } from './locks/listing.lock';
import { CompensationService } from './services/compensation.service';
import { DEPOSIT_SAGA_CONFIG, DepositSagaService } from './services/deposit-saga.service';
import type { DepositSagaConfig } from './services/deposit-saga.service';
import { ListingSyncService } from './services/listing-sync.service';
import { ViewingService } from './services/viewing.service';

/**
 * Nghiệp vụ rental. T3.2: lịch xem (`RE.VIEWING`), saga đặt cọc luồng thành công, nghe `payment.deposited`
 * (`RE.DEPOSIT_SAGA`). T3.3: bù trừ, đồng bộ trạng thái tin, `SagaReconcileJob` (`@nestjs/schedule`).
 * T3.4b: hết hạn giữ chỗ `HoldExpiryJob` (BR-09); khung job chung `IntervalJob`. Vòng đời đơn (T3.5) thêm sau.
 * `InternalHttpService`, `RedisService`, `OutboxService`, `EventHandlerRegistry` đến từ module global của template.
 */
@Module({
  imports: [TypeOrmModule.forFeature([Deposit, SagaLog, Viewing]), ScheduleModule.forRoot()],
  controllers: [DepositsController, ViewingsController],
  providers: [
    ListingClient,
    PaymentClient,
    ViewingService,
    DepositSagaService,
    ListingSyncService,
    CompensationService,
    SagaReconcileJob,
    HoldExpiryJob,
    PaymentEventsHandler,
    {
      provide: RENTAL_CLIENT_CONFIG,
      inject: [ConfigService],
      useFactory: (config: ConfigService<EnvVars, true>): RentalClientConfig => ({
        urls: {
          listing: config.get('INTERNAL_LISTING_URL', { infer: true }) ?? '',
          payment: config.get('INTERNAL_PAYMENT_URL', { infer: true }) ?? '',
        },
        timeouts: {
          listingMs: config.get('LISTING_CALL_TIMEOUT_MS', { infer: true }),
          paymentMs: config.get('PAYMENT_CALL_TIMEOUT_MS', { infer: true }),
        },
      }),
    },
    {
      provide: ListingLock,
      inject: [RedisService, ConfigService],
      useFactory: (redis: RedisService, config: ConfigService<EnvVars, true>) =>
        new ListingLock(redis.client, config.get('DEPOSIT_LOCK_TTL_MS', { infer: true })),
    },
    {
      provide: DEPOSIT_SAGA_CONFIG,
      inject: [ConfigService],
      useFactory: (config: ConfigService<EnvVars, true>): DepositSagaConfig => ({
        holdTtlSeconds: config.get('HOLD_TTL_SECONDS', { infer: true }),
      }),
    },
    {
      provide: SAGA_RECONCILE_CONFIG,
      inject: [ConfigService],
      useFactory: (config: ConfigService<EnvVars, true>): SagaReconcileConfig => ({
        intervalMs: config.get('SAGA_RECONCILE_INTERVAL_MS', { infer: true }),
        stuckAfterSeconds: config.get('SAGA_STUCK_AFTER_SECONDS', { infer: true }),
      }),
    },
    {
      provide: HOLD_EXPIRY_CONFIG,
      inject: [ConfigService],
      useFactory: (config: ConfigService<EnvVars, true>): HoldExpiryConfig => ({
        intervalMs: config.get('HOLD_EXPIRY_INTERVAL_MS', { infer: true }),
      }),
    },
    {
      provide: PAYMENT_EVENTS_CONFIG,
      inject: [ConfigService],
      useFactory: (config: ConfigService<EnvVars, true>): PaymentEventsConfig => ({
        refundWindowSeconds: config.get('REFUND_WINDOW_SECONDS', { infer: true }),
        autoReleaseSeconds: config.get('AUTO_RELEASE_SECONDS', { infer: true }),
      }),
    },
  ],
})
export class RentalModule {}
