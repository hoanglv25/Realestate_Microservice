import { Injectable, Optional } from '@nestjs/common';
import { PinoLogger } from 'nestjs-pino';
import { QueryFailedError } from 'typeorm';
import type { EntityManager } from 'typeorm';
import { getCorrelationId } from '../../common/logging/correlation-id.middleware';
import { walletInsufficient } from '../errors/payment.errors';

/** Loại giao dịch ví cộng tiền (`RE.PAYOUT/API_Spec.md`, DDL `wallet_transactions`). */
export type CreditType = 'DEPOSIT_IN' | 'LATE_PAYMENT_IN';
/** Bảng nguồn của giao dịch: `ORDER` = `payment_orders.id`, `LATE_PAYMENT` = `late_payments.id`. */
export type CreditRefType = 'ORDER' | 'LATE_PAYMENT';

export interface CreditInput {
  type: CreditType;
  amountVnd: number;
  depositId: string;
  refType: CreditRefType;
  refId: string;
  tenantId: string;
  /** Chủ trọ nhận tiền về sau; `null` với tiền đến muộn (hoàn cho người thuê). */
  ownerId: string | null;
}

/** Loại giao dịch ví trừ tiền (T3.6): chi cho chủ trọ, hoàn cho người thuê. */
export type DebitType = 'WITHDRAW_OUT' | 'REFUND_OUT';
/** `WITHDRAWAL` = `withdrawal_requests.id`, `REFUND` = `refund_requests.id`. */
export type DebitRefType = 'WITHDRAWAL' | 'REFUND';

export interface DebitInput {
  type: DebitType;
  amountVnd: number;
  depositId: string;
  refType: DebitRefType;
  refId: string;
  /** Người thuê (hoàn); `null` với lệnh rút. */
  tenantId: string | null;
  ownerId: string | null;
}

/** Kết quả kiểm bất biến E10 (`RE.PAYOUT/Processing_Flow.md §4`). */
export interface WalletInvariant {
  balanceVnd: number;
  totalInVnd: number;
  totalOutVnd: number;
  /** `balanceVnd = totalInVnd − totalOutVnd`. */
  holds: boolean;
}

/** Ràng buộc `CHECK (balance_vnd >= 0)` của `admin_wallet` (Postgres tự đặt tên). */
const BALANCE_CHECK = 'admin_wallet_balance_vnd_check';

const INSERT_TX = `
  INSERT INTO wallet_transactions (type, amount_vnd, deposit_id, ref_type, ref_id, tenant_id, owner_id, correlation_id)
  VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`;
const ADD_BALANCE = `UPDATE admin_wallet SET balance_vnd = balance_vnd + $1, updated_at = now() WHERE id = 1`;
const SUB_BALANCE = `UPDATE admin_wallet SET balance_vnd = balance_vnd - $1, updated_at = now() WHERE id = 1`;
const INVARIANT = `
  SELECT w.balance_vnd AS balance,
         COALESCE(SUM(t.amount_vnd) FILTER (WHERE t.type IN ('DEPOSIT_IN','LATE_PAYMENT_IN')), 0) AS total_in,
         COALESCE(SUM(t.amount_vnd) FILTER (WHERE t.type IN ('WITHDRAW_OUT','REFUND_OUT')), 0) AS total_out
  FROM admin_wallet w LEFT JOIN wallet_transactions t ON true
  WHERE w.id = 1
  GROUP BY w.balance_vnd`;

function isBalanceCheckViolation(err: unknown): boolean {
  if (!(err instanceof QueryFailedError)) return false;
  const driver = err.driverError as { code?: string; constraint?: string } | undefined;
  return driver?.code === '23514' && driver.constraint === BALANCE_CHECK;
}

/**
 * Ví trung gian của nền tảng (ADR-0009, `RE.PAYOUT`). `credit` (T3.4a): tiền vào; `debit` (T3.6): chi cho chủ trọ,
 * hoàn cho người thuê, chỉ gọi khi đã có chứng từ (BR-17).
 *
 * Luôn chạy trong transaction của bên gọi (`manager`): giao dịch ví, số dư và thay đổi nghiệp vụ cùng commit.
 * Bất biến E10: `balance_vnd = Σ vào − Σ ra`. `UNIQUE (ref_type, ref_id)` chặn ghi hai lần cho một nguồn.
 * Mỗi lệnh hai truy vấn.
 */
@Injectable()
export class WalletService {
  constructor(@Optional() private readonly logger?: PinoLogger) {
    this.logger?.setContext(WalletService.name);
  }

  async credit(m: EntityManager, input: CreditInput): Promise<void> {
    await m.query(INSERT_TX, [
      input.type,
      input.amountVnd,
      input.depositId,
      input.refType,
      input.refId,
      input.tenantId,
      input.ownerId,
      getCorrelationId() ?? null,
    ]);
    await m.query(ADD_BALANCE, [input.amountVnd]);
  }

  /**
   * Trừ ví: `UPDATE` số dư trước (vi phạm `CHECK (balance_vnd >= 0)` thì dừng ngay, chưa ghi giao dịch) rồi ghi
   * một dòng `wallet_transactions`. Số dư không đủ → `409 PAYMENT_WALLET_INSUFFICIENT` + log `error`: nếu bất biến
   * E10 đúng thì không bao giờ xảy ra (`RE.PAYOUT/API_Spec.md §1.2` dòng 5). Lỗi làm hỏng transaction của bên
   * gọi, nên cả thao tác rollback.
   */
  async debit(m: EntityManager, input: DebitInput): Promise<void> {
    try {
      await m.query(SUB_BALANCE, [input.amountVnd]);
    } catch (err) {
      if (!isBalanceCheckViolation(err)) throw err;
      this.logger?.error(
        { refType: input.refType, refId: input.refId, amountVnd: input.amountVnd },
        'Ví trung gian không đủ số dư để chi: bất biến E10 có thể đã bị phá',
      );
      throw walletInsufficient();
    }
    await m.query(INSERT_TX, [
      input.type,
      input.amountVnd,
      input.depositId,
      input.refType,
      input.refId,
      input.tenantId,
      input.ownerId,
      getCorrelationId() ?? null,
    ]);
  }

  /** Kiểm bất biến E10 (test 13): một truy vấn. */
  async invariant(m: EntityManager): Promise<WalletInvariant> {
    const [row] = (await m.query(INVARIANT)) as Array<{
      balance: string;
      total_in: string;
      total_out: string;
    }>;
    const balanceVnd = Number(row.balance);
    const totalInVnd = Number(row.total_in);
    const totalOutVnd = Number(row.total_out);
    return { balanceVnd, totalInVnd, totalOutVnd, holds: balanceVnd === totalInVnd - totalOutVnd };
  }
}
