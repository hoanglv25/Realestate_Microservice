import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { PayOS } from '@payos/node';
import { PinoLogger } from 'nestjs-pino';
import { EnvVars } from '../config/env.validation';
import {
  PayosClient,
  PAYOS_CLIENT_CONFIG,
  PAYOS_PAYMENT_REQUESTS,
  PAYOS_WEBHOOKS,
} from './clients/payos.client';
import type {
  PayosClientConfig,
  PayosPaymentRequests,
  PayosWebhooks,
} from './clients/payos.client';

/** Token DI của instance SDK payOS dùng chung (tạo link, hủy link, kiểm chữ ký webhook). */
const PAYOS_SDK = Symbol('PAYOS_SDK');
import { PaymentOrdersInternalController } from './controllers/payment-orders.internal.controller';
import { PayosWebhookController } from './controllers/payos-webhook.controller';
import { PaymentOrder } from './entities/payment-order.entity';
import { DepositCaptureService } from './services/deposit-capture.service';
import { PaymentOrderService } from './services/payment-order.service';
import { WalletService } from './services/wallet.service';
import { WebhookService } from './services/webhook.service';

/**
 * Nghiệp vụ payment (`RE.PAYMENT`). T3.1: payment order + payOS. T3.4a: webhook payOS, ghi nhận tiền vào ví, tiền
 * đến muộn (phát sự kiện qua outbox nên cần MessagingModule). Payout (T3.6) thêm sau.
 * Chỉ nạp khi có DB (`isPaymentEnabled`); khóa payOS và RabbitMQ bắt buộc lúc khởi động (`payment.env.ts`).
 */
@Module({
  imports: [TypeOrmModule.forFeature([PaymentOrder])],
  controllers: [PaymentOrdersInternalController, PayosWebhookController],
  providers: [
    PaymentOrderService,
    WalletService,
    DepositCaptureService,
    WebhookService,
    {
      // SDK payOS dùng chung một instance: timeout PAYOS_TIMEOUT_MS cho mỗi lần gọi; retry mặc định 2 (chỉ hủy dùng,
      // tạo link tự đặt 0); tắt log của SDK (ở mức debug nó ghi chi tiết request), payment tự log lỗi đã lọc
      provide: PAYOS_SDK,
      inject: [ConfigService],
      useFactory: (config: ConfigService<EnvVars, true>): PayOS =>
        new PayOS({
          clientId: config.get('PAYOS_CLIENT_ID', { infer: true }),
          apiKey: config.get('PAYOS_API_KEY', { infer: true }),
          checksumKey: config.get('PAYOS_CHECKSUM_KEY', { infer: true }),
          timeout: config.get('PAYOS_TIMEOUT_MS', { infer: true }),
          maxRetries: 2,
          logLevel: 'off',
        }),
    },
    {
      provide: PAYOS_PAYMENT_REQUESTS,
      inject: [PAYOS_SDK],
      useFactory: (sdk: PayOS): PayosPaymentRequests => sdk.paymentRequests,
    },
    {
      // Kiểm chữ ký webhook (chỉ cần PAYOS_CHECKSUM_KEY, không gọi mạng)
      provide: PAYOS_WEBHOOKS,
      inject: [PAYOS_SDK],
      useFactory: (sdk: PayOS): PayosWebhooks => sdk.webhooks,
    },
    {
      provide: PAYOS_CLIENT_CONFIG,
      inject: [ConfigService],
      useFactory: (config: ConfigService<EnvVars, true>): PayosClientConfig => ({
        returnUrl: config.get('PAYOS_RETURN_URL', { infer: true }),
        cancelUrl: config.get('PAYOS_CANCEL_URL', { infer: true }),
      }),
    },
    {
      provide: PayosClient,
      inject: [PAYOS_PAYMENT_REQUESTS, PAYOS_CLIENT_CONFIG, PinoLogger, PAYOS_WEBHOOKS],
      useFactory: (
        requests: PayosPaymentRequests,
        cfg: PayosClientConfig,
        logger: PinoLogger,
        webhooks: PayosWebhooks,
      ) => new PayosClient(requests, cfg, logger, webhooks),
    },
  ],
})
export class PaymentModule {}
