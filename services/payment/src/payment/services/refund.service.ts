import { Inject, Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';
import type { EntityManager } from 'typeorm';
import { OutboxService } from '../../messaging/outbox.service';
import { refundAmountVnd } from '../domain/refund-amount';
import { toRefundDto } from '../dto/payout.dto';
import type { InternalRefundDto, RefundDto, RefundRow } from '../dto/payout.dto';
import {
  isUniqueViolation,
  orderNotFound,
  orderNotPaid,
  payoutInvalidStatus,
  payoutNotFound,
} from '../errors/payment.errors';
import { AuditService } from './audit.service';
import { insertReceipt, ReceiptService } from './receipt.service';
import type { ReceiptFile } from './receipt.service';
import { updatedRows } from './sql-rows';
import { WalletService } from './wallet.service';

/** Payload `contracts/events/payment.refunded.v1.schema.json`. */
export interface RefundedPayload {
  depositId: string;
  refundRequestId: string;
  tenantId: string;
  ownerId: string;
  amountVnd: number;
  requesterType: 'TENANT' | 'SYSTEM';
}

/** Payload `contracts/events/payment.refund-rejected.v1.schema.json`. */
export interface RefundRejectedPayload {
  depositId: string;
  refundRequestId: string;
  tenantId: string;
  ownerId: string;
  reason: string;
}

const TENANT_UNIQUE = 'ux_refund_tenant_active';
/** Trạng thái chờ quản trị viên xử lý: hoàn tất, từ chối được (`§1.2` dòng 2). */
const OPEN = `('PENDING_ADMIN','FAILED')`;

const FIND_ORDER = `SELECT tenant_id, owner_id, amount_vnd, status FROM payment_orders WHERE deposit_id = $1`;
const FIND_TENANT_REFUND = `
  SELECT * FROM refund_requests
  WHERE deposit_id = $1 AND requester_type = 'TENANT' AND status IN ('PENDING_ADMIN','FAILED','COMPLETED')`;
const INSERT_TENANT_REFUND = `
  INSERT INTO refund_requests (deposit_id, tenant_id, requester_type, amount_vnd)
  VALUES ($1, $2, 'TENANT', $3)
  RETURNING *`;
const FIND_FOR_ADMIN = `
  SELECT r.*, o.owner_id AS order_owner_id
  FROM refund_requests r JOIN payment_orders o ON o.deposit_id = r.deposit_id
  WHERE r.id = $1`;
const COMPLETE = `
  UPDATE refund_requests SET status = 'COMPLETED', receipt_id = $2, processed_by = $3, processed_at = now()
  WHERE id = $1 AND status IN ${OPEN}
  RETURNING *`;
/**
 * Từ chối (`from` = PENDING_ADMIN, FAILED) hoặc đánh dấu thất bại (`from` = PENDING_ADMIN). `old` đọc trạng thái
 * trước khi sửa (cho `audit_log.before`); `payment_orders` cho `ownerId` của sự kiện. Một truy vấn.
 */
const transition = (to: 'REJECTED' | 'FAILED', from: string) => `
  UPDATE refund_requests r SET status = '${to}', reason = $2, processed_by = $3, processed_at = now()
  FROM (SELECT id, status AS old_status FROM refund_requests WHERE id = $1) old, payment_orders o
  WHERE r.id = $1 AND old.id = r.id AND o.deposit_id = r.deposit_id AND r.status IN ${from}
  RETURNING r.*, o.owner_id AS order_owner_id, old.old_status`;
const REJECT = transition('REJECTED', OPEN);
const FAIL = transition('FAILED', `('PENDING_ADMIN')`);
const FIND_STATUS = `SELECT status FROM refund_requests WHERE id = $1`;

type AdminRow = RefundRow & { order_owner_id: string };
type TransitionRow = AdminRow & { old_status: string };

const toInternal = (r: RefundRow): InternalRefundDto => ({
  refundRequestId: r.id,
  depositId: r.deposit_id,
  amountVnd: Number(r.amount_vnd),
  requesterType: 'TENANT',
  status: r.status,
});

/**
 * Yêu cầu hoàn tiền (`RE.PAYOUT/API_Spec.md §1.2, §1.3, §2`). Rental tạo yêu cầu 70% cho người thuê tự hủy
 * (`createForTenant`); yêu cầu 100% cho tiền đến muộn do `DepositCaptureService.recordLate` tạo (T3.4a). Quản trị
 * viên chuyển khoản ngoài hệ thống rồi hoàn tất kèm chứng từ (ví chỉ bị trừ lúc này, BR-17), hoặc từ chối, hoặc
 * đánh dấu thất bại để làm lại. Mọi chuyển trạng thái là `UPDATE ... WHERE status IN (...)`.
 */
@Injectable()
export class RefundService {
  constructor(
    private readonly dataSource: DataSource,
    @Inject(WalletService) private readonly wallet: WalletService,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(OutboxService) private readonly outbox: OutboxService,
    @Inject(ReceiptService) private readonly receipts: ReceiptService,
  ) {}

  /**
   * §2. Idempotent theo `depositId`: đã có yêu cầu `TENANT` đang mở / thất bại / đã xong → trả lại (`created`
   * false, `200`). Yêu cầu cũ `REJECTED` không tính (người thuê xin lại trong 48 giờ). 3 truy vấn.
   */
  async createForTenant(depositId: string): Promise<{ created: boolean; view: InternalRefundDto }> {
    const [order] = (await this.dataSource.query(FIND_ORDER, [depositId])) as Array<{
      tenant_id: string;
      amount_vnd: string;
      status: string;
    }>;
    if (!order) throw orderNotFound();
    if (order.status !== 'PAID') throw orderNotPaid();

    const existing = await this.findTenantRefund(depositId);
    if (existing) return { created: false, view: toInternal(existing) };

    try {
      const [row] = (await this.dataSource.query(INSERT_TENANT_REFUND, [
        depositId,
        order.tenant_id,
        refundAmountVnd(Number(order.amount_vnd)),
      ])) as RefundRow[];
      return { created: true, view: toInternal(row) };
    } catch (err) {
      if (!isUniqueViolation(err, TENANT_UNIQUE)) throw err;
      const raced = await this.findTenantRefund(depositId);
      if (!raced) throw err;
      return { created: false, view: toInternal(raced) };
    }
  }

  /**
   * Route 8 (§1.2). Đọc trước (không có → 404, sai trạng thái → 409) để không lưu tệp vô ích; lưu S3; rồi một
   * transaction: chứng từ, `COMPLETED`, `REFUND_OUT`, `audit_log`, `payment.refunded`. 7 truy vấn (ngưỡng ghi có
   * tiền 8). Hai quản trị viên cùng bấm: bên thua `UPDATE` 0 dòng → 409, cả transaction rollback (ví trừ một lần).
   */
  async complete(adminId: string, id: string, file: ReceiptFile | undefined): Promise<RefundDto> {
    const [pre] = (await this.dataSource.query(FIND_FOR_ADMIN, [id])) as AdminRow[];
    if (!pre) throw payoutNotFound();
    if (pre.status !== 'PENDING_ADMIN' && pre.status !== 'FAILED') throw payoutInvalidStatus();

    const stored = await this.receipts.store(file);
    return this.dataSource.transaction(async (m) => {
      const receiptId = await insertReceipt(m, stored.sha256, stored.key, adminId);
      const [row] = updatedRows<RefundRow>(await m.query(COMPLETE, [id, receiptId, adminId]));
      if (!row) throw payoutInvalidStatus();

      const amountVnd = Number(row.amount_vnd);
      await this.wallet.debit(m, {
        type: 'REFUND_OUT',
        amountVnd,
        depositId: row.deposit_id,
        refType: 'REFUND',
        refId: row.id,
        tenantId: row.tenant_id,
        // Tiền đến muộn không thuộc chủ trọ (cùng cách ghi LATE_PAYMENT_IN)
        ownerId: row.requester_type === 'TENANT' ? pre.order_owner_id : null,
      });
      await this.audit.log(m, {
        actorId: adminId,
        action: 'COMPLETE_REFUND',
        targetType: 'REFUND',
        targetId: row.id,
        before: { status: pre.status },
        after: { status: 'COMPLETED', receiptId },
      });
      await this.outbox.add<RefundedPayload>(m, 'payment.refunded', {
        depositId: row.deposit_id,
        refundRequestId: row.id,
        tenantId: row.tenant_id,
        ownerId: pre.order_owner_id,
        amountVnd,
        requesterType: row.requester_type,
      });
      return toRefundDto(row);
    });
  }

  /** Route 9 (§1.3): `REJECTED`, đơn bên rental về `PAID`. Ví không đổi. 3 truy vấn (+1 khi 0 dòng). */
  reject(adminId: string, id: string, reason: string): Promise<RefundDto> {
    return this.dataSource.transaction(async (m) => {
      const row = await this.transition(m, REJECT, id, reason, adminId);
      await this.audit.log(m, {
        actorId: adminId,
        action: 'REJECT_REFUND',
        targetType: 'REFUND',
        targetId: row.id,
        before: { status: row.old_status },
        after: { status: 'REJECTED', reason },
      });
      await this.outbox.add<RefundRejectedPayload>(m, 'payment.refund-rejected', {
        depositId: row.deposit_id,
        refundRequestId: row.id,
        tenantId: row.tenant_id,
        ownerId: row.order_owner_id,
        reason,
      });
      return toRefundDto(row);
    });
  }

  /** Route 10 (§1.3): `FAILED`, hoàn tất lại sau; KHÔNG phát sự kiện (đơn giữ `REFUND_REQUESTED`). 2 truy vấn. */
  fail(adminId: string, id: string, reason: string): Promise<RefundDto> {
    return this.dataSource.transaction(async (m) => {
      const row = await this.transition(m, FAIL, id, reason, adminId);
      await this.audit.log(m, {
        actorId: adminId,
        action: 'FAIL_REFUND',
        targetType: 'REFUND',
        targetId: row.id,
        before: { status: row.old_status },
        after: { status: 'FAILED', reason },
      });
      return toRefundDto(row);
    });
  }

  private async findTenantRefund(depositId: string): Promise<RefundRow | undefined> {
    const [row] = (await this.dataSource.query(FIND_TENANT_REFUND, [depositId])) as RefundRow[];
    return row;
  }

  /** `UPDATE` có điều kiện; 0 dòng → đọc lại một lần để chọn 404 hay 409. */
  private async transition(
    m: EntityManager,
    sql: string,
    id: string,
    reason: string,
    adminId: string,
  ): Promise<TransitionRow> {
    const [row] = updatedRows<TransitionRow>(await m.query(sql, [id, reason, adminId]));
    if (row) return row;
    const [exists] = (await m.query(FIND_STATUS, [id])) as Array<{ status: string }>;
    throw exists ? payoutInvalidStatus() : payoutNotFound();
  }
}
