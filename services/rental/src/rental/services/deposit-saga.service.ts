import { HttpException, Inject, Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { randomUUID } from 'node:crypto';
import { DataSource, Repository } from 'typeorm';
import type { QueryDeepPartialEntity } from 'typeorm/query-builder/QueryPartialEntity';
import { getCorrelationId } from '../../common/logging/correlation-id.middleware';
import { OutboxService } from '../../messaging/outbox.service';
import { classifyCall } from '../clients/call-outcome';
import { ListingClient } from '../clients/listing.client';
import { PaymentClient } from '../clients/payment.client';
import type { CreatedOrder } from '../clients/payment.client';
import { DepositCreatedDto } from '../dto/deposit.dto';
import { Deposit } from '../entities/deposit.entity';
import { SagaLog } from '../entities/saga-log.entity';
import type { SagaOutcome, SagaStep } from '../entities/saga-log.entity';
import { isUniqueViolation, listingNotAvailable } from '../errors/rental.errors';
import { ListingLock } from '../locks/listing.lock';

export interface DepositSagaConfig {
  /** `HOLD_TTL_SECONDS` (BR-07). */
  holdTtlSeconds: number;
}
export const DEPOSIT_SAGA_CONFIG = Symbol('DEPOSIT_SAGA_CONFIG');

const ACTIVE_UNIQUE = 'ux_deposits_active_listing';

/** Chi tiết lỗi ghi vào `saga_log.detail`: chỉ mã và HTTP status, không dữ liệu cá nhân. */
function errorDetail(err: unknown): Record<string, unknown> {
  if (err instanceof HttpException) {
    const res = err.getResponse() as { code?: unknown } | string;
    return { code: typeof res === 'object' ? res.code : undefined, status: err.getStatus() };
  }
  return { error: (err as { name?: string } | null)?.name ?? 'Error' };
}

/**
 * Saga đặt cọc điều phối tại rental (ADR-0004, `RE.DEPOSIT_SAGA/API_Spec.md §1`, `Component_Class_Design.md §4`).
 *
 * Thứ tự: khóa Redis theo tin → bản chụp listing → giữ chỗ ở listing (không retry) → transaction [đơn
 * `PENDING_PAYMENT` + `saga_log HOLD_LISTING OK` + outbox `rental.deposit-created`] → tạo order ở payment →
 * transaction [lưu order + `saga_log CREATE_PAYMENT_ORDER OK`] → nhả khóa. Không transaction nào bao lời gọi HTTP.
 * Giữ chỗ trước khi tạo đơn: giữ chỗ không rõ kết quả thì chưa có đơn nào để dọn, `held_until` tự hết.
 * Tạo đơn trước khi gọi payment: rental chết sau khi payment tạo link thì đơn trong DB là manh mối cho job.
 *
 * T3.2 là luồng thành công. Tạo order lỗi: ghi `saga_log` theo `CallOutcome` rồi trả lỗi; bù trừ
 * (`CompensationService`), đối soát (`SagaReconcileJob`) thuộc T3.3 (`implementation/PHASE-3.md`).
 * Truy vấn: 5 (INSERT đơn, `saga_log`, outbox; UPDATE order, INSERT `saga_log`).
 */
@Injectable()
export class DepositSagaService {
  private readonly logger = new Logger(DepositSagaService.name);

  constructor(
    private readonly dataSource: DataSource,
    @InjectRepository(SagaLog) private readonly sagaLogs: Repository<SagaLog>,
    private readonly lock: ListingLock,
    private readonly listing: ListingClient,
    private readonly payment: PaymentClient,
    private readonly outbox: OutboxService,
    @Inject(DEPOSIT_SAGA_CONFIG) private readonly config: DepositSagaConfig,
  ) {}

  async start(tenantId: string, listingId: string): Promise<DepositCreatedDto> {
    const token = await this.lock.acquire(listingId); // 409 RENTAL_DEPOSIT_IN_PROGRESS
    try {
      const snap = await this.listing.getSnapshot(listingId); // 404/503/504 chuyển nguyên
      if (snap.approvalStatus !== 'APPROVED' || snap.status !== 'AVAILABLE') {
        throw listingNotAvailable();
      }
      const depositId = randomUUID();
      const expiresAt = new Date(Date.now() + this.config.holdTtlSeconds * 1000);
      await this.listing.hold(listingId, depositId, expiresAt); // không retry; lỗi chuyển nguyên, chưa có đơn

      const deposit: Partial<Deposit> & Pick<Deposit, 'id' | 'expiresAt'> = {
        id: depositId,
        listingId,
        tenantId,
        ownerId: snap.ownerId,
        listingTitle: snap.title,
        amountVnd: snap.depositAmountVnd, // BR-04: bản chụp, không nhận từ client
        status: 'PENDING_PAYMENT',
        expiresAt,
      };
      try {
        await this.dataSource.transaction(async (m) => {
          await m.insert(Deposit, deposit);
          await m.insert(SagaLog, this.log(depositId, 'HOLD_LISTING', 'OK'));
          await this.outbox.add(m, 'rental.deposit-created', {
            depositId,
            listingId,
            tenantId,
            ownerId: snap.ownerId,
            amountVnd: snap.depositAmountVnd,
            expiresAt: expiresAt.toISOString(),
          });
        });
      } catch (err) {
        // Chưa có đơn: nhả chỗ best-effort (Processing_Flow §3 "Ghi đơn"); lớp chặn 3 → 409
        await this.releaseBestEffort(listingId, depositId);
        if (isUniqueViolation(err, ACTIVE_UNIQUE)) throw listingNotAvailable();
        throw err;
      }

      const order = await this.createOrder(deposit as Deposit);
      return {
        depositId,
        status: 'PENDING_PAYMENT',
        listingId,
        amountVnd: snap.depositAmountVnd,
        expiresAt: expiresAt.toISOString(),
        holdRemainingSeconds: Math.max(0, Math.floor((expiresAt.getTime() - Date.now()) / 1000)),
        checkoutUrl: order.checkoutUrl,
        qrCode: order.qrCode,
      };
    } finally {
      await this.lock.release(listingId, token);
    }
  }

  /** Bước 6–7. Lỗi: `saga_log` theo `CallOutcome` (C14), rồi ném nguyên lỗi (bù trừ ở T3.3). */
  private async createOrder(d: Deposit): Promise<CreatedOrder> {
    let order: CreatedOrder;
    try {
      order = await this.payment.createOrder({
        depositId: d.id,
        tenantId: d.tenantId,
        ownerId: d.ownerId,
        listingTitle: d.listingTitle,
        amountVnd: d.amountVnd,
        expiresAt: d.expiresAt,
      });
    } catch (err) {
      const outcome = classifyCall(err);
      await this.sagaLogs
        .insert(this.log(d.id, 'CREATE_PAYMENT_ORDER', outcome, errorDetail(err)))
        .catch(() => this.logger.warn(`Không ghi được saga_log cho đơn ${d.id}`));
      throw err;
    }
    await this.dataSource.transaction(async (m) => {
      await m.update(
        Deposit,
        { id: d.id },
        { paymentOrderId: order.orderId, checkoutUrl: order.checkoutUrl, qrCode: order.qrCode },
      );
      await m.insert(SagaLog, this.log(d.id, 'CREATE_PAYMENT_ORDER', 'OK'));
    });
    return order;
  }

  private async releaseBestEffort(listingId: string, depositId: string): Promise<void> {
    try {
      await this.listing.changeStatus(listingId, depositId, 'AVAILABLE');
    } catch {
      // held_until ở listing tự hết; không che lỗi gốc
      this.logger.warn(
        `Không nhả được chỗ của tin ${listingId} (đơn ${depositId}), chờ held_until hết`,
      );
    }
  }

  private log(
    depositId: string,
    step: SagaStep,
    outcome: SagaOutcome,
    detail: Record<string, unknown> | null = null,
  ): QueryDeepPartialEntity<SagaLog> {
    // jsonb: TypeORM không suy được kiểu sâu của Record<string, unknown>
    return {
      depositId,
      step,
      outcome,
      detail: detail as QueryDeepPartialEntity<SagaLog>['detail'],
      correlationId: getCorrelationId() ?? null,
    };
  }
}
