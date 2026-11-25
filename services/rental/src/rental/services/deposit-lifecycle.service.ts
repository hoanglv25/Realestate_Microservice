import { Inject, Injectable, Logger } from '@nestjs/common';
import { InjectDataSource, InjectRepository } from '@nestjs/typeorm';
import { DataSource, In, IsNull, MoreThanOrEqual, Repository } from 'typeorm';
import type { QueryDeepPartialEntity } from 'typeorm/query-builder/QueryPartialEntity';
import { getCorrelationId } from '../../common/logging/correlation-id.middleware';
import { OutboxService } from '../../messaging/outbox.service';
import { PaymentClient } from '../clients/payment.client';
import { canTransition } from '../domain/deposit-state';
import type { Caller } from '../domain/deposit-state';
import { DepositDto, WithdrawalEligibilityDto } from '../dto/deposit.dto';
import type { WithdrawalMissing } from '../dto/deposit.dto';
import { AuditLog } from '../entities/audit-log.entity';
import { Deposit } from '../entities/deposit.entity';
import {
  depositForbidden,
  depositInvalidTransition,
  depositNotFound,
  notHandedOver,
  refundPending,
  refundWindowClosed,
} from '../errors/rental.errors';
import { ListingSyncService } from './listing-sync.service';

/** Payload `rental.deposit-released.v1`. */
export interface DepositReleasedPayload {
  depositId: string;
  listingId: string;
  tenantId: string;
  ownerId: string;
  trigger: 'TENANT' | 'AUTO';
}

/** Payload `rental.deposit-handed-over.v1`. */
export interface DepositHandedOverPayload {
  depositId: string;
  listingId: string;
  tenantId: string;
  ownerId: string;
  adminId: string;
}

/**
 * Thao tác trên đơn sau `PAID` (`RE.DEPOSIT_LIFECYCLE/API_Spec.md §1` route 3, 4, 6, 7; `§2` điều kiện rút; chốt T3.5).
 *
 * Mỗi route: đọc đơn → `404` → `403` → `409` theo bảng "Thứ tự kiểm tra", rồi `UPDATE ... WHERE <trạng thái cũ>`
 * (BR-18); 0 dòng = bên khác vừa đổi đơn → `409`. Không transaction nào bao lời gọi HTTP (payment, listing).
 */
@Injectable()
export class DepositLifecycleService {
  private readonly logger = new Logger(DepositLifecycleService.name);

  constructor(
    @InjectRepository(Deposit) private readonly deposits: Repository<Deposit>,
    @InjectDataSource() private readonly dataSource: DataSource,
    @Inject(PaymentClient) private readonly payment: PaymentClient,
    @Inject(OutboxService) private readonly outbox: OutboxService,
    @Inject(ListingSyncService) private readonly sync: ListingSyncService,
  ) {}

  /**
   * Route 3 — người thuê nhận phòng: `PAID → RELEASED` trigger `TENANT` (BR-13), đích listing `RENTED`; outbox
   * `rental.deposit-released`; sau commit đẩy `RENTED` (lỗi → `SagaReconcileJob` (b)). 4 truy vấn.
   */
  async confirmMoveIn(caller: Caller, id: string): Promise<DepositDto> {
    const d = await this.loadForTenant(caller, id);
    if (!canTransition(d.status, 'RELEASED', 'TENANT')) throw depositInvalidTransition();

    const changes = {
      status: 'RELEASED' as const,
      releasedAt: new Date(),
      releaseTrigger: 'TENANT' as const,
      listingTargetStatus: 'RENTED',
      listingSyncedAt: null,
    };
    const released = await this.dataSource.transaction(async (m) => {
      const { affected } = await m.update(Deposit, { id, status: 'PAID' }, changes);
      if (!affected) return false;
      await this.outbox.add<DepositReleasedPayload>(m, 'rental.deposit-released', {
        depositId: d.id,
        listingId: d.listingId,
        tenantId: d.tenantId,
        ownerId: d.ownerId,
        trigger: 'TENANT',
      });
      return true;
    });
    if (!released) throw depositInvalidTransition();

    await this.pushListing(d, 'RENTED');
    return DepositDto.from({ ...d, ...changes } as Deposit, caller, new Date());
  }

  /**
   * Route 4 — yêu cầu hoàn (BR-12). Rental thắng cuộc đua trước (`UPDATE ... WHERE status='PAID' AND
   * refund_deadline_at >= now()`, cùng điều kiện `PAID` với `AutoReleaseJob` → một trạng thái cuối, E7), rồi mới nhờ
   * payment tạo yêu cầu 70% (`Component_Class_Design §3`). Payment lỗi (mọi loại, chốt T3.5 B4) → vẫn `200`,
   * `SagaReconcileJob` (c) gửi lại. 3 truy vấn.
   */
  async requestRefund(caller: Caller, id: string): Promise<DepositDto> {
    const d = await this.loadForTenant(caller, id);
    if (!canTransition(d.status, 'REFUND_REQUESTED', 'TENANT')) throw depositInvalidTransition();
    const now = new Date();
    if (!d.refundDeadlineAt || now.getTime() > d.refundDeadlineAt.getTime()) {
      throw refundWindowClosed();
    }

    const { affected } = await this.deposits.update(
      { id, status: 'PAID', refundDeadlineAt: MoreThanOrEqual(now) },
      { status: 'REFUND_REQUESTED', refundSyncedAt: null },
    );
    if (!affected) throw depositInvalidTransition();

    let refundSyncedAt: Date | null = null;
    try {
      await this.payment.createRefund({ depositId: id });
      refundSyncedAt = new Date();
      await this.deposits.update({ id, refundSyncedAt: IsNull() }, { refundSyncedAt });
    } catch (err) {
      this.logger.warn(
        `Chưa gửi được yêu cầu hoàn của đơn ${id} sang payment, SagaReconcileJob (c) gửi lại: ${(err as Error).message}`,
      );
    }
    return DepositDto.from(
      { ...d, status: 'REFUND_REQUESTED', refundSyncedAt } as Deposit,
      caller,
      new Date(),
    );
  }

  /**
   * Route 6 — quản trị viên bàn giao (BR-11): mốc `admin_confirmed_at`, không đổi trạng thái (đơn đã `RELEASED` vẫn
   * bàn giao được). Một transaction: mốc + `audit_log HAND_OVER` (B12) + outbox `rental.deposit-handed-over`. Đã bàn
   * giao → `200` không đổi, không ghi thêm. 4 truy vấn.
   */
  async handOver(admin: Caller, id: string): Promise<DepositDto> {
    const d = await this.deposits.findOneBy({ id });
    if (!d) throw depositNotFound();
    if (d.status === 'REFUND_REQUESTED') throw refundPending();
    if (d.status !== 'PAID' && d.status !== 'RELEASED') throw depositInvalidTransition();
    if (d.adminConfirmedAt) return DepositDto.from(d, admin, new Date());

    const adminConfirmedAt = new Date();
    const result = await this.dataSource.transaction(async (m) => {
      const { affected } = await m.update(
        Deposit,
        { id, status: In(['PAID', 'RELEASED']), adminConfirmedAt: IsNull() },
        { adminConfirmedAt, adminConfirmedBy: admin.sub },
      );
      if (!affected) {
        // Bên khác vừa đổi đơn: admin khác bàn giao (→ 200), hoặc người thuê vừa yêu cầu hoàn (→ 409)
        const now = await m.findOneBy(Deposit, { id });
        if (now?.adminConfirmedAt) return now;
        if (now?.status === 'REFUND_REQUESTED') throw refundPending();
        throw depositInvalidTransition();
      }
      // jsonb: TypeORM không suy được kiểu sâu của Record<string, unknown> (như saga-log.ts)
      type Json = QueryDeepPartialEntity<AuditLog>['before'];
      const before: Record<string, unknown> = { status: d.status, adminConfirmedAt: null };
      const after: Record<string, unknown> = {
        status: d.status,
        adminConfirmedAt: adminConfirmedAt.toISOString(),
        adminConfirmedBy: admin.sub,
      };
      await m.insert(AuditLog, {
        actorId: admin.sub,
        action: 'HAND_OVER',
        targetType: 'DEPOSIT',
        targetId: id,
        before: before as Json,
        after: after as Json,
        correlationId: getCorrelationId() ?? null,
      });
      await this.outbox.add<DepositHandedOverPayload>(m, 'rental.deposit-handed-over', {
        depositId: d.id,
        listingId: d.listingId,
        tenantId: d.tenantId,
        ownerId: d.ownerId,
        adminId: admin.sub,
      });
      return { ...d, adminConfirmedAt, adminConfirmedBy: admin.sub } as Deposit;
    });
    return DepositDto.from(result, admin, new Date());
  }

  /**
   * Route 7 — chủ trọ xác nhận (BR-11): mốc `seller_acknowledged_at`; từ đây đơn vào danh sách của chủ trọ. Chưa bàn
   * giao → `409 RENTAL_NOT_HANDED_OVER`; đã xác nhận → `200` không đổi. 2 truy vấn.
   */
  async acknowledge(owner: Caller, id: string): Promise<DepositDto> {
    const d = await this.deposits.findOneBy({ id });
    if (!d) throw depositNotFound();
    if (d.ownerId !== owner.sub) throw depositForbidden();
    if (!d.adminConfirmedAt) throw notHandedOver();
    if (d.sellerAcknowledgedAt) return DepositDto.from(d, owner, new Date());

    const sellerAcknowledgedAt = new Date();
    const { affected } = await this.deposits.update(
      { id, sellerAcknowledgedAt: IsNull() },
      { sellerAcknowledgedAt },
    );
    const result = affected
      ? ({ ...d, sellerAcknowledgedAt } as Deposit)
      : ((await this.deposits.findOneBy({ id })) ?? d); // xác nhận đồng thời: trả bản đã ghi
    return DepositDto.from(result, owner, new Date());
  }

  /**
   * `GET /internal/deposits/:id/withdrawal-eligibility` (payment hỏi, BR-15 sửa 2026-11-12): `RELEASED` cần hai mốc;
   * `REFUNDED` luôn được (phần còn lại sau hoàn 70%); còn lại `NOT_RELEASED`. Payment tự kiểm "không có lệnh rút hay
   * hoàn đang mở, mỗi đơn một lệnh rút". 1 truy vấn.
   */
  async withdrawalEligibility(id: string): Promise<WithdrawalEligibilityDto> {
    const d = await this.deposits.findOneBy({ id });
    if (!d) throw depositNotFound();
    const missing: WithdrawalMissing[] = [];
    if (d.status === 'RELEASED') {
      if (!d.adminConfirmedAt) missing.push('NOT_HANDED_OVER');
      if (!d.sellerAcknowledgedAt) missing.push('NOT_ACKNOWLEDGED');
    } else if (d.status !== 'REFUNDED') {
      missing.push('NOT_RELEASED');
    }
    return {
      depositId: d.id,
      ownerId: d.ownerId,
      amountVnd: d.amountVnd,
      status: d.status,
      eligible: missing.length === 0,
      missing,
    };
  }

  /** Đọc đơn cho route của người thuê: `404` → `403` (chỉ người thuê chủ đơn). */
  private async loadForTenant(caller: Caller, id: string): Promise<Deposit> {
    const d = await this.deposits.findOneBy({ id });
    if (!d) throw depositNotFound();
    if (d.tenantId !== caller.sub) throw depositForbidden();
    return d;
  }

  private async pushListing(d: Deposit, target: 'RENTED'): Promise<void> {
    try {
      await this.sync.push({ id: d.id, listingId: d.listingId, listingTargetStatus: target });
    } catch (err) {
      // Đích đã nằm trong DB, SagaReconcileJob (b) đẩy lại
      this.logger.warn(`Chưa đẩy được ${target} cho đơn ${d.id}: ${(err as Error).message}`);
    }
  }
}
