import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import { bigintToNumber } from '../../database/transformers';
import { ApprovalStatus, ListingStatus, PropertyType } from './listing.enums';

/** `numeric(8,2)` về number (driver pg trả chuỗi). Chỉ cột diện tích dùng nên đặt ở đây, không đưa vào `database/`. */
const numericToNumber = {
  to: (value?: number | null) => value,
  from: (value?: string | null) => (value === null || value === undefined ? value : Number(value)),
};

/**
 * Sản phẩm của chủ trọ và tin đăng là một bản ghi (ADR-0010). DDL gốc ở migration
 * `1733000000000-create-listings.ts` (`RE.LISTING/API_Spec.md §6`).
 *
 * Entity chỉ khai báo cột. Truy vấn có điều kiện, `FOR UPDATE`, PostGIS nằm ở service dưới dạng SQL
 * (xem `listing.sql.ts`), vì luật nghiệp vụ là một câu `UPDATE ... WHERE <trạng thái mong đợi>` (BR-18).
 */
@Entity('listings')
@Index('ix_listings_owner', ['ownerId', 'createdAt'])
export class Listing {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  /** Tham chiếu identity, không khóa ngoại (ADR-0005). */
  @Column({ name: 'owner_id', type: 'uuid' })
  ownerId!: string;

  @Column({ type: 'varchar', length: 200 })
  title!: string;

  @Column({ type: 'text', nullable: true })
  description!: string | null;

  @Column({ name: 'property_type', type: 'varchar', length: 20 })
  propertyType!: PropertyType;

  @Column({ name: 'price_vnd', type: 'bigint', transformer: bigintToNumber })
  priceVnd!: number;

  @Column({ name: 'deposit_amount_vnd', type: 'bigint', transformer: bigintToNumber })
  depositAmountVnd!: number;

  @Column({
    name: 'area_m2',
    type: 'numeric',
    precision: 8,
    scale: 2,
    transformer: numericToNumber,
  })
  areaM2!: number;

  @Column({ type: 'varchar', length: 300, nullable: true })
  address!: string | null;

  /** Danh mục `RE.LOCATION` (v1.5, thay cột chuỗi `city`): FK cùng service. Tên đọc qua `locationColumns`. */
  @Column({ name: 'city_id', type: 'uuid' })
  cityId!: string;

  /** Danh mục `RE.LOCATION` (v1.5, thay cột chuỗi `district`); phải thuộc `cityId` (kiểm ở service). */
  @Column({ name: 'district_id', type: 'uuid' })
  districtId!: string;

  /** WGS84. Không `select` mặc định: đọc `lat`/`lng` bằng `ST_Y/ST_X` (xem `listing.sql.ts`). */
  @Column({ type: 'geography', spatialFeatureType: 'Point', srid: 4326, select: false })
  location!: unknown;

  @Column({ type: 'text', array: true, default: () => "'{}'" })
  amenities!: string[];

  @Column({ type: 'varchar', length: 20, default: 'AVAILABLE' })
  status!: ListingStatus;

  @Column({ name: 'approval_status', type: 'varchar', length: 20, default: 'PENDING_REVIEW' })
  approvalStatus!: ApprovalStatus;

  @Column({ name: 'reject_reason', type: 'varchar', length: 500, nullable: true })
  rejectReason!: string | null;

  @Column({ name: 'reviewed_by', type: 'uuid', nullable: true })
  reviewedBy!: string | null;

  @Column({ name: 'reviewed_at', type: 'timestamptz', nullable: true })
  reviewedAt!: Date | null;

  /** Giữ chỗ (T2.3): hạn giữ và đơn đang giữ (A8, không có trong Báo cáo Bảng 3.5). */
  @Column({ name: 'held_until', type: 'timestamptz', nullable: true })
  heldUntil!: Date | null;

  @Column({ name: 'held_by_deposit_id', type: 'uuid', nullable: true })
  heldByDepositId!: string | null;

  @Column({ type: 'int', default: 0 })
  version!: number;

  @Column({ name: 'deleted_at', type: 'timestamptz', nullable: true })
  deletedAt!: Date | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt!: Date;
}
