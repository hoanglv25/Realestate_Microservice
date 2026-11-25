import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * T3.5 vòng đời đơn (`RE.DEPOSIT_LIFECYCLE/API_Spec.md §7`, v1.2): bảng `audit_log` (B12) và hai index.
 *
 * - `ix_deposits_status_created`: route 5 (`GET /admin/deposits`) lọc theo trạng thái, sắp `created_at DESC`
 *   (`non-functional-standards.md §1`: MUST index cột lọc của API danh sách).
 * - `ix_deposits_refund_sync`: `SagaReconcileJob` (c) tìm đơn `REFUND_REQUESTED` chưa tới payment.
 */
export class DepositLifecycle1736000000000 implements MigrationInterface {
  name = 'DepositLifecycle1736000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "audit_log" (
        "id" bigserial PRIMARY KEY,
        "actor_id" uuid NOT NULL,
        "action" varchar(50) NOT NULL,
        "target_type" varchar(30) NOT NULL,
        "target_id" uuid NOT NULL,
        "before" jsonb,
        "after" jsonb,
        "correlation_id" varchar(128),
        "created_at" timestamptz NOT NULL DEFAULT now()
      )
    `);
    await queryRunner.query(
      `CREATE INDEX "ix_audit_log_target" ON "audit_log" ("target_type", "target_id", "created_at")`,
    );
    await queryRunner.query(
      `CREATE INDEX "ix_deposits_status_created" ON "deposits" ("status", "created_at" DESC)`,
    );
    await queryRunner.query(
      `CREATE INDEX "ix_deposits_refund_sync" ON "deposits" ("updated_at") WHERE "status" = 'REFUND_REQUESTED' AND "refund_synced_at" IS NULL`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX "ix_deposits_refund_sync"`);
    await queryRunner.query(`DROP INDEX "ix_deposits_status_created"`);
    await queryRunner.query(`DROP TABLE "audit_log"`);
  }
}
