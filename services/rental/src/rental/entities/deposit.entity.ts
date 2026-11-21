import { Column, CreateDateColumn, Entity, PrimaryColumn, UpdateDateColumn } from 'typeorm';
import { bigintToNumber } from '../../database/transformers';

/** Trạng thái đơn đặt cọc (`RE.DEPOSIT_SAGA/API_Spec.md §6`, A1). */
export const DEPOSIT_STATUSES = [
  'PENDING_PAYMENT',
  'PAID',
  'EXPIRED',
  'CANCELLED',
  'REFUND_REQUESTED',
  'REFUNDED',
  'RELEASED',
  'WITHDRAWN',
] as const;
export type DepositStatus = (typeof DEPOSIT_STATUSES)[number];

/**
 * Đơn đặt cọc. `id` do rental sinh TRƯỚC khi giữ chỗ (gửi sang listing làm `depositId`). Bản chụp `owner_id`,
 * `listing_title`, `amount_vnd` lấy từ listing lúc đặt (BR-04, ADR-0005). Entity khai báo đủ cột của DDL; T3.2 chỉ
 * dùng phần saga, cột vòng đời đơn dùng ở T3.5. Đổi trạng thái luôn là `UPDATE ... WHERE status = <cũ>`.
 */
@Entity('deposits')
export class Deposit {
  @PrimaryColumn('uuid')
  id!: string;

  @Column({ name: 'listing_id', type: 'uuid' })
  listingId!: string;

  @Column({ name: 'tenant_id', type: 'uuid' })
  tenantId!: string;

  @Column({ name: 'owner_id', type: 'uuid' })
  ownerId!: string;

  @Column({ name: 'listing_title', type: 'varchar', length: 200 })
  listingTitle!: string;

  @Column({ name: 'amount_vnd', type: 'bigint', transformer: bigintToNumber })
  amountVnd!: number;

  @Column({ type: 'varchar', length: 20 })
  status!: DepositStatus;

  @Column({ name: 'payment_order_id', type: 'uuid', nullable: true })
  paymentOrderId!: string | null;

  @Column({ name: 'checkout_url', type: 'text', nullable: true })
  checkoutUrl!: string | null;

  @Column({ name: 'qr_code', type: 'text', nullable: true })
  qrCode!: string | null;

  /** = `held_until` gửi sang listing, = `expiresAt` của link payOS (BR-07). */
  @Column({ name: 'expires_at', type: 'timestamptz' })
  expiresAt!: Date;

  @Column({ name: 'paid_at', type: 'timestamptz', nullable: true })
  paidAt!: Date | null;

  @Column({ name: 'refund_deadline_at', type: 'timestamptz', nullable: true })
  refundDeadlineAt!: Date | null;

  @Column({ name: 'auto_release_at', type: 'timestamptz', nullable: true })
  autoReleaseAt!: Date | null;

  @Column({ name: 'cancelled_reason', type: 'varchar', length: 200, nullable: true })
  cancelledReason!: string | null;

  /** Trạng thái listing cần đồng bộ (A8); `listing_synced_at = null` = chưa đẩy sang listing. */
  @Column({ name: 'listing_target_status', type: 'varchar', length: 20, nullable: true })
  listingTargetStatus!: string | null;

  @Column({ name: 'listing_synced_at', type: 'timestamptz', nullable: true })
  listingSyncedAt!: Date | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt!: Date;
}
