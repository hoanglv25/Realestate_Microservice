import {
  Column,
  CreateDateColumn,
  Entity,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';

export const VIEWING_STATUSES = ['REQUESTED', 'DECLINED', 'CONFIRMED', 'CANCELLED'] as const;
export type ViewingStatus = (typeof VIEWING_STATUSES)[number];
export type ViewingCancelReason = 'TENANT' | 'LISTING_DEPOSITED';

/**
 * Yêu cầu xem nhà (`RE.VIEWING/API_Spec.md §4`). Không có giờ hẹn: hai bên thống nhất qua chat. Bản chụp
 * `owner_id`, `listing_title` từ listing lúc đặt lịch.
 */
@Entity('viewings')
export class Viewing {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ name: 'listing_id', type: 'uuid' })
  listingId!: string;

  @Column({ name: 'tenant_id', type: 'uuid' })
  tenantId!: string;

  @Column({ name: 'owner_id', type: 'uuid' })
  ownerId!: string;

  @Column({ name: 'listing_title', type: 'varchar', length: 200 })
  listingTitle!: string;

  @Column({ type: 'varchar', length: 20, default: 'REQUESTED' })
  status!: ViewingStatus;

  @Column({ name: 'cancel_reason', type: 'varchar', length: 30, nullable: true })
  cancelReason!: ViewingCancelReason | null;

  @Column({ type: 'varchar', length: 500, nullable: true })
  note!: string | null;

  @Column({ name: 'declined_at', type: 'timestamptz', nullable: true })
  declinedAt!: Date | null;

  @Column({ name: 'confirmed_at', type: 'timestamptz', nullable: true })
  confirmedAt!: Date | null;

  @Column({ name: 'cancelled_at', type: 'timestamptz', nullable: true })
  cancelledAt!: Date | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt!: Date;
}
