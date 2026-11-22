import { Inject, Injectable } from '@nestjs/common';
import { InternalHttpService } from '../../common/http/internal-http.service';
import { RENTAL_CLIENT_CONFIG } from './client-config';
import type { RentalClientConfig } from './client-config';

/** `ListingSnapshot` của `contracts/openapi/listing-internal.v1.yaml`. */
export interface ListingSnapshot {
  id: string;
  ownerId: string;
  title: string;
  depositAmountVnd: number;
  status: 'AVAILABLE' | 'HELD' | 'DEPOSITED' | 'RENTED' | 'HIDDEN';
  approvalStatus: 'PENDING_REVIEW' | 'APPROVED' | 'REJECTED';
}

/** Trạng thái đích khi đổi theo đơn (`PUT /internal/listings/:id/status`). */
export type ListingTargetStatus = 'AVAILABLE' | 'DEPOSITED' | 'RENTED';

/**
 * Gọi API nội bộ của listing qua `InternalHttpService` (timeout `LISTING_CALL_TIMEOUT_MS`).
 * Retry theo `RE.DEPOSIT_SAGA/API_Spec.md §2`: GET, PUT có (mặc định của wrapper); giữ chỗ POST **không** (không
 * truyền `idempotent`). Lỗi 4xx của listing được chuyển nguyên (`LISTING_NOT_AVAILABLE`, `LISTING_NOT_FOUND`, ...).
 */
@Injectable()
export class ListingClient {
  constructor(
    private readonly http: InternalHttpService,
    @Inject(RENTAL_CLIENT_CONFIG) private readonly config: RentalClientConfig,
  ) {}

  private url(path: string): string {
    return `${this.config.urls.listing}/internal/listings/${path}`;
  }

  getSnapshot(listingId: string): Promise<ListingSnapshot> {
    return this.http.get<ListingSnapshot>(this.url(listingId), {
      timeoutMs: this.config.timeouts.listingMs,
    });
  }

  /** Giữ chỗ nguyên tử ở listing (`UPDATE ... WHERE status='AVAILABLE'`). Không retry. */
  hold(listingId: string, depositId: string, heldUntil: Date): Promise<unknown> {
    return this.http.post(
      this.url(`${listingId}/holds`),
      { depositId, heldUntil: heldUntil.toISOString() },
      { timeoutMs: this.config.timeouts.listingMs },
    );
  }

  changeStatus(
    listingId: string,
    depositId: string,
    status: ListingTargetStatus,
  ): Promise<unknown> {
    return this.http.put(
      this.url(`${listingId}/status`),
      { depositId, status },
      { timeoutMs: this.config.timeouts.listingMs },
    );
  }
}
