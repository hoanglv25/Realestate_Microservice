import { BadRequestException, PayloadTooLargeException } from '@nestjs/common';
import { lastValueFrom, of, throwError } from 'rxjs';
import { AppException } from '../../common/errors/app.exception';
import { ReceiptTooLargeInterceptor } from './receipt-too-large.interceptor';

const run = (err?: unknown) =>
  lastValueFrom(
    new ReceiptTooLargeInterceptor().intercept({} as never, {
      handle: () => (err ? throwError(() => err) : of('ok')),
    }),
  );

describe('ReceiptTooLargeInterceptor (RE.PAYOUT §1.2 dòng 3)', () => {
  it('multer quá RECEIPT_MAX_BYTES (413) → 400 PAYMENT_RECEIPT_INVALID {reason: TOO_LARGE}', async () => {
    const e = (await run(new PayloadTooLargeException('File too large')).catch(
      (x: unknown) => x,
    )) as AppException;
    expect(e).toBeInstanceOf(AppException);
    expect([e.code, e.getStatus(), e.details]).toEqual([
      'PAYMENT_RECEIPT_INVALID',
      400,
      { reason: 'TOO_LARGE' },
    ]);
  });

  it('lỗi khác giữ nguyên; thành công đi qua', async () => {
    const other = new BadRequestException('Unexpected field');
    await expect(run(other)).rejects.toBe(other);
    await expect(run()).resolves.toBe('ok');
  });
});
