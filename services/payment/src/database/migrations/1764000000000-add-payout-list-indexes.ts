import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Index cho các danh sách payout (`RE.PAYOUT/API_Spec.md §7`, T3.6), theo `standards/non-functional-standards.md` §Index:
 * cột lọc và cột sắp xếp của truy vấn danh sách phải có index.
 *
 * `PayoutQueryService.page()` luôn sắp `created_at DESC, id DESC`, nên mọi index kết thúc bằng hai cột đó
 * (planner lấy thẳng theo thứ tự index, không cần bước Sort). Bộ lọc ở route 4, 5, 12 là tùy chọn, nên mỗi bảng
 * có thêm một index chỉ gồm cột sắp xếp cho trường hợp không lọc.
 *
 * Bảng tạo ở T3.1 (`CreatePaymentTables1734000000000`, đã merge) nên index nằm ở migration riêng.
 */
const INDEXES: ReadonlyArray<[name: string, table: string, columns: string]> = [
  // Route 3: lệnh rút của chủ trọ
  [
    'ix_withdrawal_owner_created',
    'withdrawal_requests',
    '"owner_id", "created_at" DESC, "id" DESC',
  ],
  // Route 4: quản trị viên xem lệnh rút, lọc status hoặc không
  ['ix_withdrawal_status_created', 'withdrawal_requests', '"status", "created_at" DESC, "id" DESC'],
  ['ix_withdrawal_created', 'withdrawal_requests', '"created_at" DESC, "id" DESC'],
  // Route 5: quản trị viên xem yêu cầu hoàn, lọc status hoặc không
  ['ix_refund_status_created', 'refund_requests', '"status", "created_at" DESC, "id" DESC'],
  ['ix_refund_created', 'refund_requests', '"created_at" DESC, "id" DESC'],
  // Route 12: lọc target_id (chọn lọc cao); chỉ lọc target_type hoặc không lọc dùng index thứ hai
  ['ix_audit_target_created', 'audit_log', '"target_id", "created_at" DESC, "id" DESC'],
  ['ix_audit_created', 'audit_log', '"created_at" DESC, "id" DESC'],
];

export class AddPayoutListIndexes1764000000000 implements MigrationInterface {
  name = 'AddPayoutListIndexes1764000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    for (const [name, table, columns] of INDEXES) {
      await queryRunner.query(`CREATE INDEX "${name}" ON "${table}" (${columns})`);
    }
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    for (const [name] of [...INDEXES].reverse()) {
      await queryRunner.query(`DROP INDEX "${name}"`);
    }
  }
}
