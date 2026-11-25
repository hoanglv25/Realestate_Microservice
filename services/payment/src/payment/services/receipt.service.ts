import { createHash } from 'node:crypto';
import type { PinoLogger } from 'nestjs-pino';
import type { EntityManager } from 'typeorm';
import { AppException } from '../../common/errors/app.exception';
import { ErrorCode } from '../../common/errors/error-codes';
import type { StorageService } from '../../storage/storage.service';
import { PAYMENT_PROOFS_BUCKET } from '../config/payment.env';
import { RECEIPT_SHA256_UNIQUE } from '../entities/transfer-receipt.entity';
import { isUniqueViolation, receiptAlreadyUsed, receiptInvalid } from '../errors/payment.errors';

/** Phần của tệp multipart (multer, lưu trong bộ nhớ) mà service cần. */
export interface ReceiptFile {
  buffer: Buffer;
  mimetype: string;
  size: number;
}

export interface StoredReceipt {
  /** Hex 64 ký tự, server tự tính (BR-17: một chứng từ một lệnh). */
  sha256: string;
  /** Khóa trong bucket `payment-proofs`. */
  key: string;
}

/** Loại nhận được (`RE.PAYOUT/API_Spec.md §6`), đuôi lưu S3 và byte đầu tệp phải có. */
const TYPES: Record<string, { ext: string; magic: number[] }> = {
  'image/jpeg': { ext: 'jpg', magic: [0xff, 0xd8, 0xff] },
  'image/png': { ext: 'png', magic: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] },
  'application/pdf': { ext: 'pdf', magic: [0x25, 0x50, 0x44, 0x46, 0x2d] }, // %PDF-
};

/**
 * Kiểm và lưu chứng từ chuyển khoản (`RE.PAYOUT §1.2` dòng 3, 6). Thứ tự: có tệp → cỡ → loại khai báo → byte đầu
 * khớp loại (chặn đổi đuôi) → `sha256` → S3. Lưu S3 TRƯỚC transaction ghi DB: DB lỗi thì tệp mồ côi (chấp nhận
 * được, `Processing_Flow §3`); khóa theo `sha256` nên tải lại cùng tệp ghi đè đúng chỗ.
 * Không phải provider Nest trực tiếp: dựng bằng factory trong `PaymentModule` (cần `RECEIPT_MAX_BYTES`).
 */
export class ReceiptService {
  constructor(
    private readonly storage: Pick<StorageService, 'putObject'>,
    private readonly maxBytes: number,
    private readonly logger?: Pick<PinoLogger, 'warn'>,
  ) {}

  async store(file: ReceiptFile | undefined): Promise<StoredReceipt> {
    if (!file || file.size === 0 || file.buffer.length === 0) throw receiptInvalid('MISSING');
    if (file.size > this.maxBytes || file.buffer.length > this.maxBytes) {
      throw receiptInvalid('TOO_LARGE');
    }
    const type = TYPES[file.mimetype];
    if (!type) throw receiptInvalid('UNSUPPORTED_TYPE');
    const head = file.buffer.subarray(0, type.magic.length);
    if (head.length < type.magic.length || type.magic.some((b, i) => head[i] !== b)) {
      throw receiptInvalid('CONTENT_MISMATCH');
    }

    const sha256 = createHash('sha256').update(file.buffer).digest('hex');
    const key = `receipts/${sha256}.${type.ext}`;
    try {
      await this.storage.putObject(PAYMENT_PROOFS_BUCKET, key, file.buffer, file.mimetype);
    } catch (err) {
      this.logger?.warn(
        { key, reason: err instanceof Error ? err.name : 'unknown' },
        'Lưu chứng từ lên S3 thất bại',
      );
      throw new AppException(
        ErrorCode.DEPENDENCY_UNAVAILABLE,
        'Không lưu được chứng từ, vui lòng thử lại sau',
        503,
      );
    }
    return { sha256, key };
  }
}

const INSERT_RECEIPT = `
  INSERT INTO transfer_receipts (sha256, object_key, uploaded_by) VALUES ($1, $2, $3) RETURNING id`;

/**
 * Ghi dòng `transfer_receipts` trong transaction hoàn tất lệnh chi (hoàn và rút). `sha256` trùng →
 * `409 PAYMENT_RECEIPT_ALREADY_USED` (BR-17, test 9): lỗi làm hỏng transaction nên lệnh không `COMPLETED`.
 */
export async function insertReceipt(
  m: EntityManager,
  sha256: string,
  key: string,
  adminId: string,
): Promise<string> {
  try {
    const [r] = (await m.query(INSERT_RECEIPT, [sha256, key, adminId])) as Array<{ id: string }>;
    return r.id;
  } catch (err) {
    if (isUniqueViolation(err, RECEIPT_SHA256_UNIQUE)) throw receiptAlreadyUsed();
    throw err;
  }
}
