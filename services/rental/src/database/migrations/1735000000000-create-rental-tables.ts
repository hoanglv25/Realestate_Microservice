import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Bảng của rental-service, đúng DDL ở `RE.DEPOSIT_SAGA/API_Spec.md §6` (đơn đặt cọc, nhật ký saga) và
 * `RE.VIEWING/API_Spec.md §4` (lịch xem). Cột của vòng đời đơn (RE.DEPOSIT_LIFECYCLE) có sẵn trong `deposits`.
 *
 * `listing_id`, `tenant_id`, `owner_id` tham chiếu service khác: không khóa ngoại (ADR-0005), có bản chụp
 * `owner_id`, `listing_title`, `amount_vnd` (BR-04).
 */
export class CreateRentalTables1735000000000 implements MigrationInterface {
  name = 'CreateRentalTables1735000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "deposits" (
        "id" uuid PRIMARY KEY,
        "listing_id" uuid NOT NULL,
        "tenant_id" uuid NOT NULL,
        "owner_id" uuid NOT NULL,
        "listing_title" varchar(200) NOT NULL,
        "amount_vnd" bigint NOT NULL CHECK ("amount_vnd" > 0),
        "status" varchar(20) NOT NULL
          CONSTRAINT "ck_deposits_status" CHECK ("status" IN ('PENDING_PAYMENT','PAID','EXPIRED','CANCELLED',
            'REFUND_REQUESTED','REFUNDED','RELEASED','WITHDRAWN')),
        "payment_order_id" uuid,
        "checkout_url" text,
        "qr_code" text,
        "expires_at" timestamptz NOT NULL,
        "paid_at" timestamptz,
        "refund_deadline_at" timestamptz,
        "auto_release_at" timestamptz,
        "release_reminded_at" timestamptz,
        "admin_confirmed_at" timestamptz,
        "admin_confirmed_by" uuid,
        "seller_acknowledged_at" timestamptz,
        "released_at" timestamptz,
        "release_trigger" varchar(10),
        "refunded_at" timestamptz,
        "withdrawn_at" timestamptz,
        "refund_synced_at" timestamptz,
        "cancelled_reason" varchar(200),
        "listing_target_status" varchar(20),
        "listing_synced_at" timestamptz,
        "version" int NOT NULL DEFAULT 0,
        "created_at" timestamptz NOT NULL DEFAULT now(),
        "updated_at" timestamptz NOT NULL DEFAULT now()
      )
    `);
    // Lớp chặn cuối: mỗi BĐS tối đa một đơn đang hoạt động (NFR01, Processing_Flow §2 lớp 3)
    await queryRunner.query(
      `CREATE UNIQUE INDEX "ux_deposits_active_listing" ON "deposits" ("listing_id") WHERE "status" IN ('PENDING_PAYMENT','PAID','REFUND_REQUESTED')`,
    );
    await queryRunner.query(
      `CREATE INDEX "ix_deposits_expiry" ON "deposits" ("expires_at") WHERE "status" = 'PENDING_PAYMENT'`,
    );
    await queryRunner.query(
      `CREATE INDEX "ix_deposits_auto_release" ON "deposits" ("auto_release_at") WHERE "status" = 'PAID'`,
    );
    await queryRunner.query(
      `CREATE INDEX "ix_deposits_listing_sync" ON "deposits" ("updated_at") WHERE "listing_synced_at" IS NULL AND "listing_target_status" IS NOT NULL`,
    );
    await queryRunner.query(
      `CREATE INDEX "ix_deposits_tenant" ON "deposits" ("tenant_id", "created_at" DESC)`,
    );
    await queryRunner.query(
      `CREATE INDEX "ix_deposits_owner" ON "deposits" ("owner_id", "created_at" DESC)`,
    );
    await queryRunner.query(`
      CREATE TABLE "saga_log" (
        "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "deposit_id" uuid NOT NULL REFERENCES "deposits"("id"),
        "step" varchar(40) NOT NULL,
        "outcome" varchar(20) NOT NULL,
        "detail" jsonb,
        "correlation_id" varchar(128),
        "created_at" timestamptz NOT NULL DEFAULT now()
      )
    `);
    await queryRunner.query(
      `CREATE INDEX "ix_saga_log_deposit" ON "saga_log" ("deposit_id", "created_at")`,
    );
    await queryRunner.query(`
      CREATE TABLE "viewings" (
        "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "listing_id" uuid NOT NULL,
        "tenant_id" uuid NOT NULL,
        "owner_id" uuid NOT NULL,
        "listing_title" varchar(200) NOT NULL,
        "status" varchar(20) NOT NULL DEFAULT 'REQUESTED'
          CONSTRAINT "ck_viewings_status" CHECK ("status" IN ('REQUESTED','DECLINED','CONFIRMED','CANCELLED')),
        "cancel_reason" varchar(30) CHECK ("cancel_reason" IN ('TENANT','LISTING_DEPOSITED')),
        "note" varchar(500),
        "declined_at" timestamptz,
        "confirmed_at" timestamptz,
        "cancelled_at" timestamptz,
        "created_at" timestamptz NOT NULL DEFAULT now(),
        "updated_at" timestamptz NOT NULL DEFAULT now(),
        CHECK (("status" = 'CANCELLED') = ("cancel_reason" IS NOT NULL))
      )
    `);
    // Mỗi người thuê một yêu cầu đang mở trên mỗi tin; cũng phục vụ câu tự hủy theo listing_id
    await queryRunner.query(
      `CREATE UNIQUE INDEX "ux_viewings_open_per_tenant" ON "viewings" ("listing_id", "tenant_id") WHERE "status" = 'REQUESTED'`,
    );
    await queryRunner.query(
      `CREATE INDEX "ix_viewings_tenant" ON "viewings" ("tenant_id", "created_at" DESC)`,
    );
    await queryRunner.query(
      `CREATE INDEX "ix_viewings_owner" ON "viewings" ("owner_id", "created_at" DESC)`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE "viewings"`);
    await queryRunner.query(`DROP TABLE "saga_log"`);
    await queryRunner.query(`DROP TABLE "deposits"`);
  }
}
