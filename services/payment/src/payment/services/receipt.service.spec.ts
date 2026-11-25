import { createHash } from 'node:crypto';
import { AppException } from '../../common/errors/app.exception';
import { ReceiptService } from './receipt.service';
import type { ReceiptFile } from './receipt.service';

const PNG = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.from('anh'),
]);
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from('anh')]);
const PDF = Buffer.from('%PDF-1.7\nchung tu');

function setup(maxBytes = 1024) {
  const storage = { putObject: jest.fn().mockResolvedValue(undefined) };
  return { storage, svc: new ReceiptService(storage as never, maxBytes) };
}

const file = (buffer: Buffer, mimetype: string): ReceiptFile => ({
  buffer,
  mimetype,
  size: buffer.length,
});

async function code(p: Promise<unknown>): Promise<[string, number, unknown]> {
  const e = (await p.catch((x: unknown) => x)) as AppException;
  expect(e).toBeInstanceOf(AppException);
  return [e.code, e.getStatus(), e.details];
}

describe('ReceiptService.store (RE.PAYOUT §1.2 dòng 3, 6; test 16)', () => {
  it.each([
    ['image/png', PNG, 'png'],
    ['image/jpeg', JPEG, 'jpg'],
    ['application/pdf', PDF, 'pdf'],
  ])(
    '%s hợp lệ: sha256 do server tính, lưu S3 payment-proofs/receipts/<sha256>.<đuôi>',
    async (mime, buf, ext) => {
      const { storage, svc } = setup();
      const sha = createHash('sha256').update(buf).digest('hex');
      await expect(svc.store(file(buf, mime))).resolves.toEqual({
        sha256: sha,
        key: `receipts/${sha}.${ext}`,
      });
      expect(storage.putObject).toHaveBeenCalledWith(
        'payment-proofs',
        `receipts/${sha}.${ext}`,
        buf,
        mime,
      );
    },
  );

  it('thiếu tệp → 400 PAYMENT_RECEIPT_INVALID (MISSING), không gọi S3', async () => {
    const { storage, svc } = setup();
    expect(await code(svc.store(undefined))).toEqual([
      'PAYMENT_RECEIPT_INVALID',
      400,
      { reason: 'MISSING' },
    ]);
    expect(await code(svc.store(file(Buffer.alloc(0), 'image/png')))).toEqual([
      'PAYMENT_RECEIPT_INVALID',
      400,
      { reason: 'MISSING' },
    ]);
    expect(storage.putObject).not.toHaveBeenCalled();
  });

  it('quá RECEIPT_MAX_BYTES → TOO_LARGE', async () => {
    const { storage, svc } = setup(8);
    expect(await code(svc.store(file(PNG, 'image/png')))).toEqual([
      'PAYMENT_RECEIPT_INVALID',
      400,
      { reason: 'TOO_LARGE' },
    ]);
    expect(storage.putObject).not.toHaveBeenCalled();
  });

  it('loại khai báo ngoài jpeg/png/pdf → UNSUPPORTED_TYPE', async () => {
    const { svc } = setup();
    expect(await code(svc.store(file(PNG, 'image/gif')))).toEqual([
      'PAYMENT_RECEIPT_INVALID',
      400,
      { reason: 'UNSUPPORTED_TYPE' },
    ]);
  });

  it.each([
    ['đổi đuôi: nội dung PDF khai là png', PDF, 'image/png'],
    ['nội dung tùy ý khai là pdf', Buffer.from('MZ\x90\x00 exe'), 'application/pdf'],
    ['png khai là jpeg', PNG, 'image/jpeg'],
  ])('byte đầu không khớp loại (%s) → CONTENT_MISMATCH, không gọi S3', async (_n, buf, mime) => {
    const { storage, svc } = setup();
    expect(await code(svc.store(file(buf, mime)))).toEqual([
      'PAYMENT_RECEIPT_INVALID',
      400,
      { reason: 'CONTENT_MISMATCH' },
    ]);
    expect(storage.putObject).not.toHaveBeenCalled();
  });

  it('S3 lỗi → 503 DEPENDENCY_UNAVAILABLE (chưa ghi DB)', async () => {
    const storage = { putObject: jest.fn().mockRejectedValueOnce(new Error('ECONNREFUSED')) };
    const logger = { warn: jest.fn() };
    const svc = new ReceiptService(storage as never, 1024, logger);
    expect((await code(svc.store(file(PNG, 'image/png')))).slice(0, 2)).toEqual([
      'DEPENDENCY_UNAVAILABLE',
      503,
    ]);
    expect(logger.warn).toHaveBeenCalledTimes(1);
  });
});
