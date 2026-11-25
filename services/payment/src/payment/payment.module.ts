import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { MulterModule } from '@nestjs/platform-express';
import { TypeOrmModule } from '@nestjs/typeorm';
import { PayOS } from '@payos/node';
import { PinoLogger } from 'nestjs-pino';
import { EnvVars } from '../config/env.validation';
import { StorageService } from '../storage/storage.service';
import { IdentityClient } from './clients/identity.client';
import { PAYOUT_URLS } from './clients/payout-urls';
import type { PayoutUrls } from './clients/payout-urls';
import { RentalClient } from './clients/rental.client';
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
import { PayoutsAdminController } from './controllers/payouts.admin.controller';
import { PaymentOrdersInternalController } from './controllers/payment-orders.internal.controller';
import { PayosWebhookController } from './controllers/payos-webhook.controller';
import { RefundRequestsInternalController } from './controllers/refund-requests.internal.controller';
import { TransactionsController } from './controllers/transactions.controller';
import { WithdrawalsController } from './controllers/withdrawals.controller';
import { AuditLog } from './entities/audit-log.entity';
import { PaymentOrder } from './entities/payment-order.entity';
import { RefundRequest } from './entities/refund-request.entity';
import { TransferReceipt } from './entities/transfer-receipt.entity';
import { WithdrawalRequest } from './entities/withdrawal-request.entity';
import { ReceiptTooLargeInterceptor } from './http/receipt-too-large.interceptor';
import { AuditService } from './services/audit.service';
import { DepositCaptureService } from './services/deposit-capture.service';
import { PaymentOrderService } from './services/payment-order.service';
import { PayoutQueryService } from './services/payout-query.service';
import { ReceiptService } from './services/receipt.service';
import { RefundService } from './services/refund.service';
import { WalletService } from './services/wallet.service';
import { WebhookService } from './services/webhook.service';
import { WithdrawalService } from './services/withdrawal.service';

/**
 * Nghiệp vụ payment (`RE.PAYMENT`). T3.1: payment order + payOS. T3.4a: webhook payOS, ghi nhận tiền vào ví, tiền
 * đến muộn (phát sự kiện qua outbox nên cần MessagingModule). T3.6 (`RE.PAYOUT`): hoàn, rút, chứng từ, ví, nhật ký.
 * Chỉ nạp khi có DB (`isPaymentEnabled`); khóa payOS, RabbitMQ, Redis, S3, URL nội bộ bắt buộc lúc khởi động
 * (`payment.env.ts`; riêng NODE_ENV=test bỏ qua kiểm tra nên các phụ thuộc payout có thể vắng mặt).
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([
      PaymentOrder,
      RefundRequest,
      WithdrawalRequest,
      TransferReceipt,
      AuditLog,
    ]),
    // Chứng từ (route 6, 8): nhận trong bộ nhớ, multer chặn ngay khi vượt RECEIPT_MAX_BYTES (→ 400 qua
    // ReceiptTooLargeInterceptor), tối đa một tệp
    MulterModule.registerAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService<EnvVars, true>) => ({
        limits: { fileSize: config.get('RECEIPT_MAX_BYTES', { infer: true }), files: 1 },
      }),
    }),
  ],
  controllers: [
    PaymentOrdersInternalController,
    PayosWebhookController,
    RefundRequestsInternalController,
    TransactionsController,
    WithdrawalsController,
    PayoutsAdminController,
  ],
  providers: [
    PaymentOrderService,
    WalletService,
    DepositCaptureService,
    WebhookService,
    AuditService,
    RefundService,
    WithdrawalService,
    PayoutQueryService,
    RentalClient,
    IdentityClient,
    ReceiptTooLargeInterceptor,
    {
      provide: PAYOUT_URLS,
      inject: [ConfigService],
      useFactory: (config: ConfigService<EnvVars, true>): PayoutUrls => ({
        rental: config.get('INTERNAL_RENTAL_URL', { infer: true }) ?? '',
        identity: config.get('INTERNAL_IDENTITY_URL', { infer: true }) ?? '',
      }),
    },
    {
      // StorageService chỉ có khi bật S3 (bắt buộc ở môi trường thật). Thiếu (một số test) → lưu chứng từ báo 503.
      provide: ReceiptService,
      inject: [{ token: StorageService, optional: true }, ConfigService, PinoLogger],
      useFactory: (
        storage: StorageService | undefined,
        config: ConfigService<EnvVars, true>,
        logger: PinoLogger,
      ): ReceiptService => {
        logger.setContext(ReceiptService.name);
        return new ReceiptService(
          storage ?? { putObject: () => Promise.reject(new Error('S3 chưa bật')) },
          config.get('RECEIPT_MAX_BYTES', { infer: true }),
          logger,
        );
      },
    },
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
