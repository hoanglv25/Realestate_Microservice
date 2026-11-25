/** Tỉ lệ hoàn khi người thuê tự hủy trong 48 giờ (BR-12). Báo cáo cố định, không cấu hình. */
export const REFUND_PERCENT = 70;

/**
 * Số tiền hoàn cho người thuê = `floor(tiền cọc × 70 / 100)` VND (`RE.PAYOUT/API_Spec.md §2`, chốt 2026-11-16).
 * Tính bằng số nguyên (nhân trước, chia sau) để không sai do số thực. Phần còn lại (30%) thuộc chủ trọ.
 */
export function refundAmountVnd(depositVnd: number): number {
  if (!Number.isSafeInteger(depositVnd) || depositVnd <= 0) {
    throw new RangeError('Tiền cọc phải là số nguyên dương (VND)');
  }
  return Math.floor((depositVnd * REFUND_PERCENT) / 100);
}
