import { Injectable } from '@nestjs/common';
import type { EntityManager } from 'typeorm';
import { getCorrelationId } from '../../common/logging/correlation-id.middleware';

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

const INSERT_TX = `
  INSERT INTO wallet_transactions (type, amount_vnd, deposit_id, ref_type, ref_id, tenant_id, owner_id, correlation_id)
  VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`;
const ADD_BALANCE = `UPDATE admin_wallet SET balance_vnd = balance_vnd + $1, updated_at = now() WHERE id = 1`;

/**
 * Ví trung gian của nền tảng (ADR-0009, `RE.PAYOUT`). T3.4a chỉ có **cộng** (`credit`); trừ (rút, hoàn) thêm ở T3.6.
 *
 * Luôn chạy trong transaction của bên gọi (`manager`): giao dịch ví, số dư và thay đổi nghiệp vụ cùng commit.
 * Bất biến E10: `balance_vnd = Σ vào − Σ ra`. `UNIQUE (ref_type, ref_id)` chặn cộng hai lần cho một nguồn.
 * Hai truy vấn.
 */
@Injectable()
export class WalletService {
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
}
