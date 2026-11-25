import { Inject, Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';
import type { PageQueryDto } from '../../common/response/page-query.dto';
import { Paginated } from '../../common/response/response-meta';
import { IdentityClient } from '../clients/identity.client';
import { toRefundDto, toWithdrawalDto } from '../dto/payout.dto';
import type {
  AuditLogDto,
  BankAccountDto,
  ListAuditLogsQuery,
  ListRefundsQuery,
  ListWithdrawalsQuery,
  RefundDetailDto,
  RefundDto,
  RefundRow,
  WalletSummaryDto,
  WalletTransactionDto,
  WithdrawalDetailDto,
  WithdrawalDto,
  WithdrawalRow,
} from '../dto/payout.dto';
import { payoutNotFound } from '../errors/payment.errors';

const WALLET = `
  SELECT (SELECT balance_vnd FROM admin_wallet WHERE id = 1) AS balance,
         (SELECT COALESCE(SUM(amount_vnd), 0) FROM withdrawal_requests WHERE status = 'PENDING') AS withdrawal,
         (SELECT COALESCE(SUM(amount_vnd), 0) FROM refund_requests
          WHERE status IN ('PENDING_ADMIN','FAILED')) AS refund`;

/** Một trang của bảng `table`: dòng (`ORDER BY created_at DESC, id DESC`) + tổng. Hai truy vấn. */
interface PageSpec {
  select: string;
  table: string;
  where: string;
  params: unknown[];
}

type TxRow = {
  id: string;
  type: string;
  amount_vnd: string;
  deposit_id: string | null;
  created_at: Date;
};
type AuditRow = {
  id: string;
  actor_id: string;
  action: string;
  target_type: string;
  target_id: string;
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
  correlation_id: string | null;
  created_at: Date;
};

const toBankAccount = (
  b: { bankName: string; accountHolder: string; accountNumber: string } | null,
) =>
  b
    ? ({
        bankName: b.bankName,
        accountHolder: b.accountHolder,
        accountNumber: b.accountNumber,
      } as BankAccountDto)
    : null;

/**
 * Các route chỉ đọc của payout (`RE.PAYOUT/API_Spec.md §1.4, §1.5`). Danh sách: 2 truy vấn, không gọi service khác
 * (cấm gọi trong vòng lặp). Chi tiết cho quản trị viên (route 13, 14): 1 truy vấn + 1 lời gọi identity lấy số tài
 * khoản đầy đủ ngay lúc xem; payment không lưu, không log số này.
 */
@Injectable()
export class PayoutQueryService {
  constructor(
    private readonly dataSource: DataSource,
    @Inject(IdentityClient) private readonly identity: IdentityClient,
  ) {}

  /** Route 1 (BR-19): giao dịch ví mà người gọi là người thuê HOẶC chủ trọ. */
  async myTransactions(userId: string, q: PageQueryDto): Promise<Paginated<WalletTransactionDto>> {
    const { rows, total } = await this.page<TxRow>(
      {
        select: 'id, type, amount_vnd, deposit_id, created_at',
        table: 'wallet_transactions',
        where: '(tenant_id = $1 OR owner_id = $1)',
        params: [userId],
      },
      q,
    );
    return new Paginated(
      rows.map((r) => ({
        id: r.id,
        type: r.type,
        amountVnd: Number(r.amount_vnd),
        depositId: r.deposit_id,
        createdAt: new Date(r.created_at).toISOString(),
      })),
      q.page,
      q.pageSize,
      total,
    );
  }

  /** Route 3. */
  async myWithdrawals(ownerId: string, q: PageQueryDto): Promise<Paginated<WithdrawalDto>> {
    const { rows, total } = await this.page<WithdrawalRow>(
      { select: '*', table: 'withdrawal_requests', where: 'owner_id = $1', params: [ownerId] },
      q,
    );
    return new Paginated(rows.map(toWithdrawalDto), q.page, q.pageSize, total);
  }

  /** Route 4. */
  async adminWithdrawals(q: ListWithdrawalsQuery): Promise<Paginated<WithdrawalDto>> {
    const { rows, total } = await this.page<WithdrawalRow>(
      {
        select: '*',
        table: 'withdrawal_requests',
        where: '($1::text IS NULL OR status = $1)',
        params: [q.status ?? null],
      },
      q,
    );
    return new Paginated(rows.map(toWithdrawalDto), q.page, q.pageSize, total);
  }

  /** Route 5. */
  async adminRefunds(q: ListRefundsQuery): Promise<Paginated<RefundDto>> {
    const { rows, total } = await this.page<RefundRow>(
      {
        select: '*',
        table: 'refund_requests',
        where: '($1::text IS NULL OR status = $1)',
        params: [q.status ?? null],
      },
      q,
    );
    return new Paginated(rows.map(toRefundDto), q.page, q.pageSize, total);
  }

  /** Route 11: một truy vấn. */
  async wallet(): Promise<WalletSummaryDto> {
    const [r] = (await this.dataSource.query(WALLET)) as Array<{
      balance: string;
      withdrawal: string;
      refund: string;
    }>;
    return {
      balanceVnd: Number(r.balance),
      pendingWithdrawalVnd: Number(r.withdrawal),
      pendingRefundVnd: Number(r.refund),
    };
  }

  /** Route 12. */
  async auditLogs(q: ListAuditLogsQuery): Promise<Paginated<AuditLogDto>> {
    const { rows, total } = await this.page<AuditRow>(
      {
        select: '*',
        table: 'audit_log',
        where: '($1::text IS NULL OR target_type = $1) AND ($2::uuid IS NULL OR target_id = $2)',
        params: [q.targetType ?? null, q.targetId ?? null],
      },
      q,
    );
    return new Paginated(
      rows.map((r) => ({
        id: String(r.id),
        actorId: r.actor_id,
        action: r.action,
        targetType: r.target_type,
        targetId: r.target_id,
        before: r.before,
        after: r.after,
        correlationId: r.correlation_id,
        createdAt: new Date(r.created_at).toISOString(),
      })),
      q.page,
      q.pageSize,
      total,
    );
  }

  /** Route 13 (§1.5): chủ trọ chưa khai → `bankAccount: null`. */
  async withdrawalDetail(id: string): Promise<WithdrawalDetailDto> {
    const [row] = (await this.dataSource.query(`SELECT * FROM withdrawal_requests WHERE id = $1`, [
      id,
    ])) as WithdrawalRow[];
    if (!row) throw payoutNotFound();
    const bank = await this.identity.getBankAccount(row.owner_id);
    return { ...toWithdrawalDto(row), bankAccount: toBankAccount(bank) };
  }

  /** Route 14 (§1.5): người thuê chưa khai (thường là tiền đến muộn) → `bankAccount: null`, hỏi qua chat. */
  async refundDetail(id: string): Promise<RefundDetailDto> {
    const [row] = (await this.dataSource.query(`SELECT * FROM refund_requests WHERE id = $1`, [
      id,
    ])) as RefundRow[];
    if (!row) throw payoutNotFound();
    const bank = await this.identity.getBankAccount(row.tenant_id);
    return { ...toRefundDto(row), bankAccount: toBankAccount(bank) };
  }

  private async page<T>(spec: PageSpec, q: PageQueryDto): Promise<{ rows: T[]; total: number }> {
    const n = spec.params.length;
    const rows = (await this.dataSource.query(
      `SELECT ${spec.select} FROM ${spec.table} WHERE ${spec.where}
       ORDER BY created_at DESC, id DESC LIMIT $${n + 1} OFFSET $${n + 2}`,
      [...spec.params, q.pageSize, q.skip],
    )) as T[];
    const [count] = (await this.dataSource.query(
      `SELECT count(*) AS total FROM ${spec.table} WHERE ${spec.where}`,
      spec.params,
    )) as Array<{ total: string }>;
    return { rows, total: Number(count.total) };
  }
}
