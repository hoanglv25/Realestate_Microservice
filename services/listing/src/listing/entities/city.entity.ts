import { Column, CreateDateColumn, Entity, PrimaryGeneratedColumn } from 'typeorm';

/**
 * Tỉnh/thành trong danh mục địa giới (`RE.LOCATION/API_Spec.md §6`). Dữ liệu chỉ đọc, nạp bởi
 * migration `1733200000000-create-locations.ts`. Entity chỉ khai báo cột.
 */
@Entity('cities')
export class City {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'varchar', length: 100 })
  name!: string;

  @Column({ name: 'sort_order', type: 'smallint' })
  sortOrder!: number;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;
}
