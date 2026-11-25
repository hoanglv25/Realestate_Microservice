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
import { DepositsAdminController } from './controllers/deposits.admin.controller';
import { DepositsController } from './controllers/deposits.controller';
import { DepositsInternalController } from './controllers/deposits.internal.controller';
import { ViewingsController } from './controllers/viewings.controller';
import { AuditLog } from './entities/audit-log.entity';
import { Deposit } from './entities/deposit.entity';
import { SagaLog } from './entities/saga-log.entity';
import { Viewing } from './entities/viewing.entity';
import { PAYMENT_EVENTS_CONFIG, PaymentEventsHandler } from './events/payment-events.handler';
import type { PaymentEventsConfig } from './events/payment-events.handler';
import { AUTO_RELEASE_CONFIG, AutoReleaseJob } from './jobs/auto-release.job';
import type { AutoReleaseConfig } from './jobs/auto-release.job';
import { DEADLINE_CONFIG, DeadlineJob } from './jobs/deadline.job';
import type { DeadlineConfig } from './jobs/deadline.job';
import { HOLD_EXPIRY_CONFIG, HoldExpiryJob } from './jobs/hold-expiry.job';
import type { HoldExpiryConfig } from './jobs/hold-expiry.job';
import { SAGA_RECONCILE_CONFIG, SagaReconcileJob } from './jobs/saga-reconcile.job';
import type { SagaReconcileConfig } from './jobs/saga-reconcile.job';
import { ListingLock } from './locks/listing.lock';
import { CompensationService } from './services/compensation.service';
import { DepositLifecycleService } from './services/deposit-lifecycle.service';
import { DepositQueryService } from './services/deposit-query.service';
import { DEPOSIT_SAGA_CONFIG, DepositSagaService } from './services/deposit-saga.service';
import type { DepositSagaConfig } from './services/deposit-saga.service';
import { ListingSyncService } from './services/listing-sync.service';
import { ViewingService } from './services/viewing.service';

/**
 * Nghiệp vụ rental. T3.2: lịch xem (`RE.VIEWING`), saga đặt cọc luồng thành công, nghe `payment.deposited`
 * (`RE.DEPOSIT_SAGA`). T3.3: bù trừ, đồng bộ trạng thái tin, `SagaReconcileJob` (`@nestjs/schedule`).
 * T3.4b: hết hạn giữ chỗ `HoldExpiryJob` (BR-09); khung job chung `IntervalJob`. T3.5: vòng đời đơn
 * (`RE.DEPOSIT_LIFECYCLE`): route 1–7, `withdrawal-eligibility`, `AutoReleaseJob`, `DeadlineJob`, job (c), 3 sự kiện.
 * `InternalHttpService`, `RedisService`, `OutboxService`, `EventHandlerRegistry` đến từ module global của template.
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([Deposit, SagaLog, Viewing, AuditLog]),
    ScheduleModule.forRoot(),
  ],
  controllers: [
    DepositsController,
    DepositsAdminController,
    DepositsInternalController,
    ViewingsController,
  ],
  providers: [
    ListingClient,
    PaymentClient,
    ViewingService,
    DepositSagaService,
    ListingSyncService,
    CompensationService,
    DepositQueryService,
    DepositLifecycleService,
    SagaReconcileJob,
    HoldExpiryJob,
    AutoReleaseJob,
    DeadlineJob,
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
      provide: AUTO_RELEASE_CONFIG,
      inject: [ConfigService],
      useFactory: (config: ConfigService<EnvVars, true>): AutoReleaseConfig => ({
        intervalMs: config.get('AUTO_RELEASE_INTERVAL_MS', { infer: true }),
      }),
    },
    {
      provide: DEADLINE_CONFIG,
      inject: [ConfigService],
      useFactory: (config: ConfigService<EnvVars, true>): DeadlineConfig => ({
        intervalMs: config.get('DEADLINE_INTERVAL_MS', { infer: true }),
        reminderSeconds: config.get('RELEASE_REMINDER_SECONDS', { infer: true }),
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
