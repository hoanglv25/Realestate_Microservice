import { REFUND_PERCENT, refundAmountVnd } from './refund-amount';

describe('refundAmountVnd (RE.PAYOUT test 1, BR-12)', () => {
  it('tỉ lệ 70% là hằng số (Báo cáo cố định)', () => {
    expect(REFUND_PERCENT).toBe(70);
  });

  it.each([
    [3_000_000, 2_100_000],
    [3_000_001, 2_100_000], // floor: 2_100_000.7 → 2_100_000
    [10, 7],
    [1, 0], // 0.7 → 0: bên gọi phải chặn số 0 (CHECK amount_vnd > 0)
  ])('%i VND → %i VND (floor)', (deposit, refund) => {
    expect(refundAmountVnd(deposit)).toBe(refund);
  });

  it('không dùng số thực: số lớn vẫn đúng tới đồng', () => {
    expect(refundAmountVnd(9_007_199_254_740)).toBe(6_305_039_478_318);
  });

  it.each([0, -1, 1.5, Number.NaN])('tiền cọc không phải số nguyên dương (%p) → ném lỗi', (v) => {
    expect(() => refundAmountVnd(v)).toThrow(RangeError);
  });
});
