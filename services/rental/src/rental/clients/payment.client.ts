import { Inject, Injectable } from '@nestjs/common';
import { InternalHttpService } from '../../common/http/internal-http.service';
import { RENTAL_CLIENT_CONFIG } from './client-config';
import type { RentalClientConfig } from './client-config';

export interface CreateOrderInput {
  depositId: string;
  tenantId: string;
  ownerId: string;
  listingTitle: string;
  amountVnd: number;
  expiresAt: Date;
}

/** `data` của `CreateOrderResponse` (`contracts/openapi/payment-internal.v1.yaml`). */
export interface CreatedOrder {
  orderId: string;
  payosOrderCode: number;
  checkoutUrl: string;
  qrCode: string;
  expiresAt: string;
}

/** `PaymentOrder` của hợp đồng. */
export interface PaymentOrderView {
  orderId: string;
  depositId: string;
  status: 'PENDING' | 'PAID' | 'CANCELLED';
  amountVnd: number;
  payosOrderCode: number;
  checkoutUrl: string | null;
  expiresAt: string;
  paidAt: string | null;
}

/**
 * Gọi API nội bộ của payment (timeout `PAYMENT_CALL_TIMEOUT_MS`). Mọi lệnh idempotent theo `depositId` nên đều
 * được retry (`idempotent: true` cho POST, `RE.DEPOSIT_SAGA/API_Spec.md §2`).
 */
@Injectable()
export class PaymentClient {
  constructor(
    private readonly http: InternalHttpService,
    @Inject(RENTAL_CLIENT_CONFIG) private readonly config: RentalClientConfig,
  ) {}

  private url(path = ''): string {
    return `${this.config.urls.payment}/internal/payment-orders${path}`;
  }

  createOrder(input: CreateOrderInput): Promise<CreatedOrder> {
    return this.http.post<CreatedOrder>(
      this.url(),
      { ...input, expiresAt: input.expiresAt.toISOString() },
      { timeoutMs: this.config.timeouts.paymentMs, idempotent: true },
    );
  }

  cancelOrder(depositId: string): Promise<unknown> {
    return this.http.post(this.url(`/${depositId}/cancel`), undefined, {
      timeoutMs: this.config.timeouts.paymentMs,
      idempotent: true,
    });
  }

  getOrder(depositId: string): Promise<PaymentOrderView> {
    return this.http.get<PaymentOrderView>(this.url(`/${depositId}`), {
      timeoutMs: this.config.timeouts.paymentMs,
    });
  }
}
