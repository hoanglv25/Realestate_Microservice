import { QueryFailedError } from 'typeorm';
import { AppException } from '../../common/errors/app.exception';
import { ErrorCode } from '../../common/errors/error-codes';

/**
 * Mã lỗi nghiệp vụ của rental (`RE.DEPOSIT_SAGA/API_Spec.md §4`, `RE.VIEWING/API_Spec.md §3`,
 * `RE.DEPOSIT_LIFECYCLE/API_Spec.md §5`).
 * `LISTING_*` là mã của listing: lỗi 4xx từ listing được `InternalHttpService` chuyển nguyên; rental chỉ tự ném
 * hai mã này khi chính nó kết luận từ bản chụp (tin chưa duyệt, không `AVAILABLE`).
 */
export const RentalError = {
  DEPOSIT_IN_PROGRESS: 'RENTAL_DEPOSIT_IN_PROGRESS', // 409 (BR-06)
  DEPOSIT_NOT_FOUND: 'RENTAL_DEPOSIT_NOT_FOUND', // 404
  VIEWING_NOT_FOUND: 'RENTAL_VIEWING_NOT_FOUND', // 404
  VIEWING_OWN_LISTING: 'RENTAL_VIEWING_OWN_LISTING', // 403
  VIEWING_DUPLICATE: 'RENTAL_VIEWING_DUPLICATE', // 409
  INVALID_TRANSITION: 'RENTAL_INVALID_TRANSITION', // 409 (BR-18)
  REFUND_WINDOW_CLOSED: 'RENTAL_REFUND_WINDOW_CLOSED', // 409 (BR-12)
  REFUND_PENDING: 'RENTAL_REFUND_PENDING', // 409 (BR-11)
  NOT_HANDED_OVER: 'RENTAL_NOT_HANDED_OVER', // 409 (BR-11)
  LISTING_NOT_AVAILABLE: 'LISTING_NOT_AVAILABLE', // 409 (BR-05)
  LISTING_NOT_FOUND: 'LISTING_NOT_FOUND', // 404
} as const;

export const depositInProgress = (): AppException =>
  new AppException(
    RentalError.DEPOSIT_IN_PROGRESS,
    'Có người đang đặt cọc tin này, vui lòng thử lại',
    409,
  );

export const viewingNotFound = (): AppException =>
  new AppException(RentalError.VIEWING_NOT_FOUND, 'Không tìm thấy lịch xem', 404);

export const viewingOwnListing = (): AppException =>
  new AppException(
    RentalError.VIEWING_OWN_LISTING,
    'Không thể đặt lịch xem tin của chính mình',
    403,
  );

export const viewingDuplicate = (): AppException =>
  new AppException(
    RentalError.VIEWING_DUPLICATE,
    'Bạn đã có yêu cầu xem đang chờ cho tin này',
    409,
  );

export const invalidTransition = (): AppException =>
  new AppException(RentalError.INVALID_TRANSITION, 'Không thể chuyển trạng thái', 409);

export const depositNotFound = (): AppException =>
  new AppException(RentalError.DEPOSIT_NOT_FOUND, 'Không tìm thấy đơn đặt cọc', 404);

/** Vòng đời đơn: không thể thực hiện ở trạng thái hiện tại (BR-18). */
export const depositInvalidTransition = (): AppException =>
  new AppException(
    RentalError.INVALID_TRANSITION,
    'Không thể thực hiện ở trạng thái hiện tại của đơn',
    409,
  );

export const refundWindowClosed = (): AppException =>
  new AppException(
    RentalError.REFUND_WINDOW_CLOSED,
    'Đã quá 48 giờ kể từ lúc thanh toán, không thể yêu cầu hoàn',
    409,
  );

export const refundPending = (): AppException =>
  new AppException(RentalError.REFUND_PENDING, 'Đơn đang có yêu cầu hoàn tiền', 409);

export const notHandedOver = (): AppException =>
  new AppException(RentalError.NOT_HANDED_OVER, 'Quản trị viên chưa bàn giao đơn', 409);

export const depositForbidden = (): AppException =>
  new AppException(ErrorCode.FORBIDDEN, 'Bạn không có quyền với đơn đặt cọc này', 403);

export const notRelated = (): AppException =>
  new AppException(ErrorCode.FORBIDDEN, 'Bạn không có quyền với lịch xem này', 403);

export const listingNotAvailable = (): AppException =>
  new AppException(RentalError.LISTING_NOT_AVAILABLE, 'Tin không còn trống để đặt cọc', 409);

export const listingNotFound = (): AppException =>
  new AppException(RentalError.LISTING_NOT_FOUND, 'Không tìm thấy tin đăng', 404);

/** Lỗi `23505` (unique_violation) của Postgres trên đúng ràng buộc `constraint`. */
export function isUniqueViolation(err: unknown, constraint: string): boolean {
  if (!(err instanceof QueryFailedError)) return false;
  const driver = err.driverError as { code?: string; constraint?: string } | undefined;
  return driver?.code === '23505' && driver.constraint === constraint;
}
