import { Column, CreateDateColumn, Entity, PrimaryGeneratedColumn } from 'typeorm';

/**
 * Quận/huyện thuộc một tỉnh/thành (`RE.LOCATION/API_Spec.md §6`). Không khai báo `@ManyToOne` để không
 * nạp lười ngoài ý muốn (`RE.LOCATION/Component_Class_Design.md §2`); `city_id` có FK ở DDL.
 */
@Entity('districts')
export class District {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ name: 'city_id', type: 'uuid' })
  cityId!: string;

  @Column({ type: 'varchar', length: 100 })
  name!: string;

  @Column({ name: 'sort_order', type: 'smallint' })
  sortOrder!: number;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;
}
