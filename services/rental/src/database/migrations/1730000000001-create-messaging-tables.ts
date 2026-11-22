import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Bảng của MessagingModule (src/messaging): outbox (event chờ gửi) và inbox (event đã xử lý).
 * GIỮ migration này khi copy template nếu service publish hoặc consume event.
 */
export class CreateMessagingTables1730000000001 implements MigrationInterface {
  name = 'CreateMessagingTables1730000000001';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "outbox_events" (
        "id" uuid NOT NULL,
        "event_type" text NOT NULL,
        "envelope" jsonb NOT NULL,
        "created_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
        "published_at" TIMESTAMPTZ,
        "attempts" integer NOT NULL DEFAULT 0,
        "last_error" text,
        CONSTRAINT "PK_outbox_events" PRIMARY KEY ("id")
      )
    `);
    // Relay chỉ quét event chưa gửi, theo thứ tự tạo
    await queryRunner.query(`
      CREATE INDEX "IDX_outbox_events_pending" ON "outbox_events" ("created_at")
      WHERE "published_at" IS NULL
    `);
    await queryRunner.query(`
      CREATE TABLE "processed_events" (
        "event_id" uuid NOT NULL,
        "event_type" text NOT NULL,
        "processed_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
        CONSTRAINT "PK_processed_events" PRIMARY KEY ("event_id")
      )
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE "processed_events"`);
    await queryRunner.query(`DROP TABLE "outbox_events"`);
  }
}
