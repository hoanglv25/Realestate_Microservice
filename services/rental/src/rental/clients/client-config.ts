/** URL nội bộ và timeout cho lời gọi từ rental (`RE.DEPOSIT_SAGA/API_Spec.md §5`). Token DI: `RENTAL_CLIENT_CONFIG`. */
export interface RentalClientConfig {
  urls: { listing: string; payment: string };
  timeouts: { listingMs: number; paymentMs: number };
}

export const RENTAL_CLIENT_CONFIG = Symbol('RENTAL_CLIENT_CONFIG');
