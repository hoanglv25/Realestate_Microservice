import type {
  CreatePaymentLinkRequest,
  CreatePaymentLinkResponse,
  PaymentLink,
  Webhook,
  WebhookData,
} from '@payos/node';
import { PinoLogger } from 'nestjs-pino';
import { providerUnavailable } from '../errors/payment.errors';

/** Phần SDK `@payos/node` mà payment dùng (`payOS.paymentRequests`); test thay bằng bản giả. */
export interface PayosPaymentRequests {
  create(
    data: CreatePaymentLinkRequest,
    options?: { maxRetries?: number },
  ): Promise<CreatePaymentLinkResponse>;
  cancel(orderCode: number, cancellationReason?: string): Promise<PaymentLink>;
}

/** Phần SDK `@payos/node` dùng cho webhook (`payOS.webhooks`): kiểm chữ ký bằng `PAYOS_CHECKSUM_KEY`. */
export interface PayosWebhooks {
  verify(webhook: Webhook): Promise<WebhookData>;
}

export interface PayosClientConfig {
  /** `PAYOS_RETURN_URL`: trang Next.js sau khi trả tiền (không phải bằng chứng thanh toán). */
  returnUrl: string;
  /** `PAYOS_CANCEL_URL`. */
  cancelUrl: string;
}

export interface CreateLinkInput {
  orderCode: number;
  amountVnd: number;
  listingTitle: string | null;
  /** Link hết hạn đúng lúc giữ chỗ hết hạn (BR-07). */
  expiresAt: Date;
}

export interface PaymentLinkInfo {
  paymentLinkId: string;
  checkoutUrl: string;
  qrCode: string;
}

/** Token DI của phần SDK (module dựng `new PayOS(...).paymentRequests`). */
export const PAYOS_PAYMENT_REQUESTS = Symbol('PAYOS_PAYMENT_REQUESTS');
/** Token DI của phần webhook SDK (module dựng `new PayOS(...).webhooks`). */
export const PAYOS_WEBHOOKS = Symbol('PAYOS_WEBHOOKS');
/** Token DI của cấu hình. */
export const PAYOS_CLIENT_CONFIG = Symbol('PAYOS_CLIENT_CONFIG');

/** payOS giới hạn `description` 25 ký tự (một số ngân hàng chỉ hiện 9): dùng mã ngắn, tiêu đề đưa vào `items`. */
const description = (orderCode: number): string => `DC${orderCode}`.slice(0, 25);
const ITEM_FALLBACK = 'Đặt cọc';

/**
 * Bọc SDK payOS (`RE.PAYMENT/Component_Class_Design.md §1`, `reliability-standard.md §3`).
 *
 * - Timeout mỗi lần gọi là `PAYOS_TIMEOUT_MS` (đặt lúc dựng SDK, phải < 3.000 ms của rental).
 * - Tạo link **không retry** (`maxRetries: 0`): retry có thể tạo trùng. Hủy link dùng retry mặc định của client
 *   (idempotent, chốt 2026-11-16).
 * - Mọi lỗi (mạng, timeout, 5xx, payOS từ chối với `code ≠ '00'`) thành `503 PAYMENT_PROVIDER_UNAVAILABLE`.
 *   Log `warn` chỉ ghi thao tác, `orderCode`, tên lỗi, HTTP status và mã payOS; không ghi thông điệp gốc hay khóa.
 * - Kiểm chữ ký webhook (`verify`) bằng SDK: ký lại `data` (sắp khóa, HMAC-SHA256 với `PAYOS_CHECKSUM_KEY`) và so
 *   với `signature`. Không gọi mạng.
 */
export class PayosClient {
  constructor(
    private readonly requests: PayosPaymentRequests,
    private readonly config: PayosClientConfig,
    private readonly logger: PinoLogger,
    private readonly webhooks: PayosWebhooks,
  ) {
    this.logger.setContext(PayosClient.name);
  }

  async createLink(input: CreateLinkInput): Promise<PaymentLinkInfo> {
    try {
      const link = await this.requests.create(
        {
          orderCode: input.orderCode,
          amount: input.amountVnd,
          description: description(input.orderCode),
          returnUrl: this.config.returnUrl,
          cancelUrl: this.config.cancelUrl,
          expiredAt: Math.floor(input.expiresAt.getTime() / 1000),
          items: [
            {
              name: input.listingTitle?.trim() || ITEM_FALLBACK,
              quantity: 1,
              price: input.amountVnd,
            },
          ],
        },
        { maxRetries: 0 },
      );
      return {
        paymentLinkId: link.paymentLinkId,
        checkoutUrl: link.checkoutUrl,
        qrCode: link.qrCode,
      };
    } catch (err) {
      throw this.unavailable('createLink', input.orderCode, err);
    }
  }

  async cancelLink(orderCode: number): Promise<void> {
    try {
      await this.requests.cancel(orderCode, 'Hết hạn giữ chỗ hoặc hủy đơn');
    } catch (err) {
      throw this.unavailable('cancelLink', orderCode, err);
    }
  }

  /**
   * `true` khi body webhook có chữ ký hợp lệ. Mọi trường hợp khác (sai chữ ký, `data` bị sửa, thiếu trường, body
   * không phải object) trả `false`, không ném: webhook vẫn được lưu và trả `200` (`RE.PAYMENT/API_Spec.md §1`).
   * Log `warn` chỉ ghi lý do của SDK, không ghi body (có số tài khoản người chuyển).
   */
  async verify(raw: unknown): Promise<boolean> {
    if (typeof raw !== 'object' || raw === null) {
      this.logger.warn(
        { op: 'verifyWebhook', reason: 'body không phải object' },
        'Webhook payOS sai chữ ký',
      );
      return false;
    }
    try {
      await this.webhooks.verify(raw as Webhook);
      return true;
    } catch (err) {
      const reason = err instanceof Error ? err.message : 'không rõ';
      this.logger.warn({ op: 'verifyWebhook', reason }, 'Webhook payOS sai chữ ký');
      return false;
    }
  }

  private unavailable(op: string, orderCode: number, err: unknown) {
    const e = (err ?? {}) as { name?: unknown; status?: unknown; code?: unknown };
    this.logger.warn(
      { op, orderCode, errName: e.name, status: e.status, payosCode: e.code },
      'Gọi payOS thất bại',
    );
    return providerUnavailable();
  }
}
