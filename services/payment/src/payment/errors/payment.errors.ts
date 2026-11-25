import { QueryFailedError } from 'typeorm';
import { AppException } from '../../common/errors/app.exception';

/** Mã lỗi nghiệp vụ của payment-service (`RE.PAYMENT/API_Spec.md §4`, `RE.PAYOUT/API_Spec.md §5`). Ổn định: rental dựa vào mã này. */
export const PaymentError = {
  ORDER_NOT_FOUND: 'PAYMENT_ORDER_NOT_FOUND', // 404
  ORDER_ALREADY_PAID: 'PAYMENT_ORDER_ALREADY_PAID', // 409 (BR-09)
  ORDER_CANCELLED: 'PAYMENT_ORDER_CANCELLED', // 409
  ORDER_EXPIRED: 'PAYMENT_ORDER_EXPIRED', // 409 (BR-07)
  PROVIDER_UNAVAILABLE: 'PAYMENT_PROVIDER_UNAVAILABLE', // 503
  // --- Payout (`RE.PAYOUT/API_Spec.md §5`, T3.6) ---
  WITHDRAWAL_NOT_ELIGIBLE: 'PAYMENT_WITHDRAWAL_NOT_ELIGIBLE', // 409 (BR-15)
  PAYOUT_ALREADY_OPEN: 'PAYMENT_PAYOUT_ALREADY_OPEN', // 409 (BR-15, BR-16)
  BANK_ACCOUNT_MISSING: 'PAYMENT_BANK_ACCOUNT_MISSING', // 409
  PAYOUT_NOT_FOUND: 'PAYMENT_PAYOUT_NOT_FOUND', // 404
  PAYOUT_INVALID_STATUS: 'PAYMENT_PAYOUT_INVALID_STATUS', // 409
  RECEIPT_INVALID: 'PAYMENT_RECEIPT_INVALID', // 400 (BR-17)
  RECEIPT_ALREADY_USED: 'PAYMENT_RECEIPT_ALREADY_USED', // 409 (BR-17)
  WALLET_INSUFFICIENT: 'PAYMENT_WALLET_INSUFFICIENT', // 409 (NFR01)
  ORDER_NOT_PAID: 'PAYMENT_ORDER_NOT_PAID', // 409
} as const;

export const orderNotFound = (): AppException =>
  new AppException(PaymentError.ORDER_NOT_FOUND, 'Không tìm thấy lệnh thanh toán', 404);

export const orderAlreadyPaid = (): AppException =>
  new AppException(PaymentError.ORDER_ALREADY_PAID, 'Lệnh thanh toán đã được thanh toán', 409);

export const orderCancelled = (): AppException =>
  new AppException(PaymentError.ORDER_CANCELLED, 'Lệnh thanh toán đã hủy', 409);

export const orderExpired = (): AppException =>
  new AppException(PaymentError.ORDER_EXPIRED, 'Thời gian giữ chỗ đã hết', 409);

export const providerUnavailable = (): AppException =>
  new AppException(
    PaymentError.PROVIDER_UNAVAILABLE,
    'Cổng thanh toán tạm thời không phản hồi',
    503,
  );

// --- Payout (`RE.PAYOUT/API_Spec.md §5`) ---

/** `missing`: lý do rental trả (`NOT_RELEASED`, `NOT_HANDED_OVER`, `NOT_ACKNOWLEDGED`); rỗng khi số tiền rút bằng 0. */
export const withdrawalNotEligible = (missing: string[] = []): AppException =>
  new AppException(PaymentError.WITHDRAWAL_NOT_ELIGIBLE, 'Đơn chưa đủ điều kiện rút tiền', 409, {
    missing,
  });

export const payoutAlreadyOpen = (): AppException =>
  new AppException(PaymentError.PAYOUT_ALREADY_OPEN, 'Đơn đã có lệnh rút hoặc yêu cầu hoàn', 409);

export const bankAccountMissing = (): AppException =>
  new AppException(PaymentError.BANK_ACCOUNT_MISSING, 'Vui lòng khai tài khoản nhận tiền', 409);

export const payoutNotFound = (): AppException =>
  new AppException(PaymentError.PAYOUT_NOT_FOUND, 'Không tìm thấy lệnh chi', 404);

export const payoutInvalidStatus = (): AppException =>
  new AppException(
    PaymentError.PAYOUT_INVALID_STATUS,
    'Lệnh chi không ở trạng thái xử lý được',
    409,
  );

export const receiptInvalid = (reason: string): AppException =>
  new AppException(PaymentError.RECEIPT_INVALID, 'Chứng từ không hợp lệ', 400, { reason });

export const receiptAlreadyUsed = (): AppException =>
  new AppException(PaymentError.RECEIPT_ALREADY_USED, 'Chứng từ đã được dùng cho lệnh khác', 409);

export const walletInsufficient = (): AppException =>
  new AppException(PaymentError.WALLET_INSUFFICIENT, 'Số dư ví trung gian không đủ', 409);

export const orderNotPaid = (): AppException =>
  new AppException(PaymentError.ORDER_NOT_PAID, 'Đơn chưa được thanh toán', 409);

/** Lỗi `23505` (unique_violation) của Postgres trên đúng ràng buộc `constraint`. */
export function isUniqueViolation(err: unknown, constraint: string): boolean {
  if (!(err instanceof QueryFailedError)) return false;
  const driver = err.driverError as { code?: string; constraint?: string } | undefined;
  return driver?.code === '23505' && driver.constraint === constraint;
}
