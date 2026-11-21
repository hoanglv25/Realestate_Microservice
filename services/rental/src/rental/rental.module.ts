import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
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
import { ListingLock } from './locks/listing.lock';
import { DEPOSIT_SAGA_CONFIG, DepositSagaService } from './services/deposit-saga.service';
import type { DepositSagaConfig } from './services/deposit-saga.service';
import { ViewingService } from './services/viewing.service';

/**
 * Nghiệp vụ rental. T3.2: lịch xem (`RE.VIEWING`), saga đặt cọc luồng thành công, nghe `payment.deposited`
 * (`RE.DEPOSIT_SAGA`). Bù trừ, job (T3.3, T3.4), vòng đời đơn (T3.5) thêm sau.
 * `InternalHttpService`, `RedisService`, `OutboxService`, `EventHandlerRegistry` đến từ module global của template.
 */
@Module({
  imports: [TypeOrmModule.forFeature([Deposit, SagaLog, Viewing])],
  controllers: [DepositsController, ViewingsController],
  providers: [
    ListingClient,
    PaymentClient,
    ViewingService,
    DepositSagaService,
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
