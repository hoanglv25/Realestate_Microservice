import { Inject, Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { AppException } from '../../common/errors/app.exception';
import { ErrorCode } from '../../common/errors/error-codes';
import { OutboxService } from '../../messaging/outbox.service';
import { IdentityClient } from '../clients/identity.client';
import { RentalClient } from '../clients/rental.client';
import { toWithdrawalDto } from '../dto/payout.dto';
import type { WithdrawalDto, WithdrawalRow } from '../dto/payout.dto';
import type { BankSnapshot } from '../entities/withdrawal-request.entity';
import {
  bankAccountMissing,
  isUniqueViolation,
  payoutAlreadyOpen,
  payoutInvalidStatus,
  payoutNotFound,
  withdrawalNotEligible,
} from '../errors/payment.errors';
import { AuditService } from './audit.service';
import { insertReceipt, ReceiptService } from './receipt.service';
import type { ReceiptFile } from './receipt.service';
import { updatedRows } from './sql-rows';
import { WalletService } from './wallet.service';

/** Payload `payment.withdrawal-requested` / `-completed` (`contracts/events/`). */
export interface WithdrawalPayload {
  withdrawalId: string;
  depositId: string;
  ownerId: string;
  amountVnd: number;
}
/** Payload `payment.withdrawal-failed`. */
export type WithdrawalFailedPayload = WithdrawalPayload & { reason: string };

const ACTIVE_UNIQUE = 'ux_withdrawal_active';

/**
 * Một truy vấn cho cả bước 4 và số tiền của `§1.1`: đơn đã có lệnh rút `PENDING`/`COMPLETED` chưa; đã có yêu cầu
 * hoàn đang chờ (`PENDING_ADMIN`/`FAILED`) chưa (BR-15, BR-16); tổng đã hoàn cho người thuê (đơn `REFUNDED`).
 */
const PAYOUT_STATE = `
  SELECT
    EXISTS (SELECT 1 FROM withdrawal_requests
            WHERE deposit_id = $1 AND status IN ('PENDING','COMPLETED')) AS withdrawal_open,
    EXISTS (SELECT 1 FROM refund_requests
            WHERE deposit_id = $1 AND status IN ('PENDING_ADMIN','FAILED')) AS refund_open,
    COALESCE((SELECT SUM(amount_vnd) FROM refund_requests
              WHERE deposit_id = $1 AND requester_type = 'TENANT' AND status = 'COMPLETED'), 0) AS refunded_vnd`;
const INSERT_WITHDRAWAL = `
  INSERT INTO withdrawal_requests (deposit_id, owner_id, amount_vnd, bank_snapshot)
  VALUES ($1, $2, $3, $4)
  RETURNING *`;
const FIND = `SELECT * FROM withdrawal_requests WHERE id = $1`;
const COMPLETE = `
  UPDATE withdrawal_requests SET status = 'COMPLETED', receipt_id = $2, processed_by = $3, processed_at = now()
  WHERE id = $1 AND status = 'PENDING'
  RETURNING *`;
const FAIL = `
  UPDATE withdrawal_requests SET status = 'FAILED', reason = $2, processed_by = $3, processed_at = now()
  WHERE id = $1 AND status = 'PENDING'
  RETURNING *`;
const FIND_STATUS = `SELECT status FROM withdrawal_requests WHERE id = $1`;

const payload = (r: WithdrawalRow): WithdrawalPayload => ({
  withdrawalId: r.id,
  depositId: r.deposit_id,
  ownerId: r.owner_id,
  amountVnd: Number(r.amount_vnd),
});

/**
 * Lệnh rút tiền của chủ trọ (`RE.PAYOUT/API_Spec.md §1.1–1.3`, BR-15, BR-16, BR-17). Số tiền do payment tính:
 * tiền cọc (bản chụp của rental) trừ tổng đã hoàn cho người thuê; đơn `RELEASED` thì tổng này bằng 0.
 * Quản trị viên chuyển khoản ngoài hệ thống rồi hoàn tất kèm chứng từ (ví chỉ bị trừ lúc này) hoặc đánh dấu
 * thất bại (chủ trọ sửa ngân hàng rồi tạo lệnh mới).
 */
@Injectable()
export class WithdrawalService {
  constructor(
    private readonly dataSource: DataSource,
    @Inject(RentalClient) private readonly rental: RentalClient,
    @Inject(IdentityClient) private readonly identity: IdentityClient,
    @Inject(WalletService) private readonly wallet: WalletService,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(OutboxService) private readonly outbox: OutboxService,
    @Inject(ReceiptService) private readonly receipts: ReceiptService,
  ) {}

  /**
   * Route 2. Thứ tự kiểm theo `§1.1`: rental (404 chuyển nguyên) → chủ trọ của đơn (403) → đủ điều kiện (409
   * kèm `missing`) → không có lệnh mở (409) → identity (chưa khai → 409). Rental, identity lỗi → 503/504, chưa
   * ghi gì. Ghi: một transaction `INSERT` + outbox. Truy vấn: 1 đọc + 2 ghi; 2 lời gọi service.
   */
  async create(ownerId: string, depositId: string): Promise<WithdrawalDto> {
    const elig = await this.rental.withdrawalEligibility(depositId);
    if (elig.ownerId !== ownerId) {
      throw new AppException(ErrorCode.FORBIDDEN, 'Bạn không phải chủ trọ của đơn này', 403);
    }
    if (!elig.eligible) throw withdrawalNotEligible(elig.missing);

    const [state] = (await this.dataSource.query(PAYOUT_STATE, [depositId])) as Array<{
      withdrawal_open: boolean;
      refund_open: boolean;
      refunded_vnd: string;
    }>;
    if (state.withdrawal_open || state.refund_open) throw payoutAlreadyOpen();
    const amountVnd = elig.amountVnd - Number(state.refunded_vnd);
    if (amountVnd <= 0) throw withdrawalNotEligible([]);

    const bank = await this.identity.getBankAccount(ownerId);
    if (!bank) throw bankAccountMissing();
    // Chỉ lưu bản đã che: số đầy đủ lấy lại từ identity lúc quản trị viên xem (route 13, `§1.5`)
    const snapshot: BankSnapshot = {
      bankName: bank.bankName,
      accountHolder: bank.accountHolder,
      accountLast4: bank.accountNumber.slice(-4),
    };

    try {
      return await this.dataSource.transaction(async (m) => {
        const [row] = (await m.query(INSERT_WITHDRAWAL, [
          depositId,
          ownerId,
          amountVnd,
          JSON.stringify(snapshot),
        ])) as WithdrawalRow[];
        await this.outbox.add<WithdrawalPayload>(m, 'payment.withdrawal-requested', payload(row));
        return toWithdrawalDto(row);
      });
    } catch (err) {
      // Hai lệnh cùng lúc lọt qua bước kiểm: unique index chặn lệnh thứ hai
      if (isUniqueViolation(err, ACTIVE_UNIQUE)) throw payoutAlreadyOpen();
      throw err;
    }
  }

  /**
   * Route 6 (§1.2). Như `RefundService.complete`: đọc trước (404/409, không lưu tệp vô ích) → S3 → một
   * transaction: chứng từ, `COMPLETED`, `WITHDRAW_OUT`, `audit_log`, `payment.withdrawal-completed`. 7 truy vấn.
   */
  async complete(
    adminId: string,
    id: string,
    file: ReceiptFile | undefined,
  ): Promise<WithdrawalDto> {
    const [pre] = (await this.dataSource.query(FIND, [id])) as WithdrawalRow[];
    if (!pre) throw payoutNotFound();
    if (pre.status !== 'PENDING') throw payoutInvalidStatus();

    const stored = await this.receipts.store(file);
    return this.dataSource.transaction(async (m) => {
      const receiptId = await insertReceipt(m, stored.sha256, stored.key, adminId);
      const [row] = updatedRows<WithdrawalRow>(await m.query(COMPLETE, [id, receiptId, adminId]));
      if (!row) throw payoutInvalidStatus();

      const event = payload(row);
      await this.wallet.debit(m, {
        type: 'WITHDRAW_OUT',
        amountVnd: event.amountVnd,
        depositId: row.deposit_id,
        refType: 'WITHDRAWAL',
        refId: row.id,
        tenantId: null,
        ownerId: row.owner_id,
      });
      await this.audit.log(m, {
        actorId: adminId,
        action: 'COMPLETE_WITHDRAWAL',
        targetType: 'WITHDRAWAL',
        targetId: row.id,
        before: { status: 'PENDING' },
        after: { status: 'COMPLETED', receiptId },
      });
      await this.outbox.add<WithdrawalPayload>(m, 'payment.withdrawal-completed', event);
      return toWithdrawalDto(row);
    });
  }

  /** Route 7 (§1.3): `FAILED`, ví không đổi, phát `payment.withdrawal-failed`. 3 truy vấn (+1 khi 0 dòng). */
  fail(adminId: string, id: string, reason: string): Promise<WithdrawalDto> {
    return this.dataSource.transaction(async (m) => {
      const [row] = updatedRows<WithdrawalRow>(await m.query(FAIL, [id, reason, adminId]));
      if (!row) {
        const [exists] = (await m.query(FIND_STATUS, [id])) as Array<{ status: string }>;
        throw exists ? payoutInvalidStatus() : payoutNotFound();
      }
      await this.audit.log(m, {
        actorId: adminId,
        action: 'FAIL_WITHDRAWAL',
        targetType: 'WITHDRAWAL',
        targetId: row.id,
        before: { status: 'PENDING' },
        after: { status: 'FAILED', reason },
      });
      await this.outbox.add<WithdrawalFailedPayload>(m, 'payment.withdrawal-failed', {
        ...payload(row),
        reason,
      });
      return toWithdrawalDto(row);
    });
  }
}
