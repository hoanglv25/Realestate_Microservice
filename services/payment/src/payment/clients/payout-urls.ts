/** URL nội bộ cho lời gọi từ payment (`RE.PAYOUT/API_Spec.md §3, §6`). Token DI: `PAYOUT_URLS`. */
export interface PayoutUrls {
  rental: string;
  identity: string;
}

export const PAYOUT_URLS = Symbol('PAYOUT_URLS');
