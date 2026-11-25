import { Inject, Injectable } from '@nestjs/common';
import { InternalHttpService } from '../../common/http/internal-http.service';
import { PAYOUT_URLS } from './payout-urls';
import type { PayoutUrls } from './payout-urls';

/** Lý do chưa được rút (`contracts/openapi/rental-internal.v1.yaml`, `WithdrawalEligibility.missing`). */
export type EligibilityMissing = 'NOT_RELEASED' | 'NOT_HANDED_OVER' | 'NOT_ACKNOWLEDGED';

/** `data` của `getWithdrawalEligibility` (`rental-internal.v1.yaml`). */
export interface WithdrawalEligibility {
  depositId: string;
  /** Chủ trọ của đơn (bản chụp); payment so với `sub` của người tạo lệnh rút. */
  ownerId: string;
  /** Tiền cọc của đơn, KHÔNG phải số tiền được rút (payment tự tính, `RE.PAYOUT §1.1`). */
  amountVnd: number;
  status: string;
  eligible: boolean;
  missing: EligibilityMissing[];
}

/**
 * Gọi API nội bộ của rental (`RE.PAYOUT/API_Spec.md §3`). Chỉ đọc nên được retry (GET); timeout mặc định
 * `HTTP_TIMEOUT_MS`. Lỗi (4xx của rental, 503/504) chuyển nguyên cho người gọi.
 */
@Injectable()
export class RentalClient {
  constructor(
    private readonly http: InternalHttpService,
    @Inject(PAYOUT_URLS) private readonly urls: PayoutUrls,
  ) {}

  withdrawalEligibility(depositId: string): Promise<WithdrawalEligibility> {
    return this.http.get<WithdrawalEligibility>(
      `${this.urls.rental}/internal/deposits/${depositId}/withdrawal-eligibility`,
    );
  }
}
