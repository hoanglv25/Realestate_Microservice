import { Inject, Injectable } from '@nestjs/common';
import { AppException } from '../../common/errors/app.exception';
import { InternalHttpService } from '../../common/http/internal-http.service';
import { PAYOUT_URLS } from './payout-urls';
import type { PayoutUrls } from './payout-urls';

/** Mã identity trả khi người dùng chưa khai tài khoản nhận tiền (`RE.IDENTITY/API_Spec.md §3`). */
const BANK_ACCOUNT_NOT_FOUND = 'IDENTITY_BANK_ACCOUNT_NOT_FOUND';

/** `data` của `getBankAccountForPayout` (`contracts/openapi/identity-internal.v1.yaml`). Số đầy đủ: KHÔNG log, KHÔNG lưu. */
export interface BankAccount {
  userId: string;
  bankName: string;
  accountHolder: string;
  accountNumber: string;
}

/**
 * Gọi API nội bộ của identity (`RE.PAYOUT/API_Spec.md §3`). Chỉ đọc nên được retry (GET).
 * Chưa khai tài khoản → `null` (bên gọi quyết định: tạo lệnh rút báo `PAYMENT_BANK_ACCOUNT_MISSING`, chi tiết
 * cho quản trị viên trả `bankAccount: null`, `§1.5`). Lỗi khác chuyển nguyên.
 */
@Injectable()
export class IdentityClient {
  constructor(
    private readonly http: InternalHttpService,
    @Inject(PAYOUT_URLS) private readonly urls: PayoutUrls,
  ) {}

  async getBankAccount(userId: string): Promise<BankAccount | null> {
    try {
      return await this.http.get<BankAccount>(
        `${this.urls.identity}/internal/users/${userId}/bank-account`,
      );
    } catch (err) {
      if (err instanceof AppException && err.code === BANK_ACCOUNT_NOT_FOUND) return null;
      throw err;
    }
  }
}
