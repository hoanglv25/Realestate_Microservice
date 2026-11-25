import { Column, CreateDateColumn, Entity, PrimaryGeneratedColumn } from 'typeorm';

/** Tên ràng buộc UNIQUE của `sha256` (Postgres tự đặt): trùng → `409 PAYMENT_RECEIPT_ALREADY_USED`. */
export const RECEIPT_SHA256_UNIQUE = 'transfer_receipts_sha256_key';

/**
 * Chứng từ chuyển khoản quản trị viên tải lên khi hoàn tất lệnh chi (BR-17). `sha256` do server tính, duy nhất:
 * một chứng từ không dùng cho hai lệnh. Tệp nằm ở S3 bucket `payment-proofs`, khóa `object_key`.
 */
@Entity('transfer_receipts')
export class TransferReceipt {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'char', length: 64 })
  sha256!: string;

  @Column({ name: 'object_key', type: 'varchar', length: 300 })
  objectKey!: string;

  @Column({ name: 'uploaded_by', type: 'uuid' })
  uploadedBy!: string;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;
}
