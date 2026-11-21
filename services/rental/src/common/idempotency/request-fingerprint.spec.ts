import { fingerprintBody } from './request-fingerprint';

describe('fingerprintBody', () => {
  it('cùng nội dung nhưng khác thứ tự khóa (kể cả lồng nhau) -> cùng vân tay', () => {
    expect(fingerprintBody({ a: 1, b: { x: 1, y: [1, { p: 1, q: 2 }] } })).toBe(
      fingerprintBody({ b: { y: [1, { q: 2, p: 1 }], x: 1 }, a: 1 }),
    );
  });

  it('khác nội dung -> khác vân tay; thứ tự phần tử mảng có ý nghĩa', () => {
    expect(fingerprintBody({ amountVnd: 100 })).not.toBe(fingerprintBody({ amountVnd: 101 }));
    expect(fingerprintBody([1, 2])).not.toBe(fingerprintBody([2, 1]));
  });

  it('body rỗng/undefined/null coi như nhau', () => {
    expect(fingerprintBody(undefined)).toBe(fingerprintBody(null));
  });
});
