import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Tin đăng tham chiếu danh mục `RE.LOCATION` bằng id (`RE.LISTING/API_Spec.md §6.1`, v1.5, ADR-0015).
 * Chạy sau `1733200000000-create-locations.ts`. Một transaction (mặc định của TypeORM).
 *
 * 1. Thêm `city_id`, `district_id` (tạm cho phép NULL), có FK cùng service (ADR-0005).
 * 2. Ánh xạ theo tên: `listings.city` = `cities.name` và `listings.district` = `districts.name` của tỉnh đó.
 * 3. XÓA CỨNG tin không ánh xạ được (kể cả tin đã xóa mềm) và ảnh của chúng (chốt 2026-11-26). Object
 *    trên S3 nằm lại (như tech-debt #14). Đơn ở rental trỏ tới tin bị xóa nhận 404 ở API nội bộ.
 * 4. `NOT NULL` hai cột id.
 * 5. Bỏ cột chuỗi, index tìm kiếm chuyển sang `district_id`, thêm index theo `city_id`.
 *
 * `down` không khôi phục được tin đã xóa ở bước 3.
 */
export class ListingsLocationIds1733300000000 implements MigrationInterface {
  name = 'ListingsLocationIds1733300000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "listings"
        ADD COLUMN "city_id" uuid,
        ADD COLUMN "district_id" uuid,
        ADD CONSTRAINT "FK_listings_city" FOREIGN KEY ("city_id") REFERENCES "cities" ("id"),
        ADD CONSTRAINT "FK_listings_district" FOREIGN KEY ("district_id") REFERENCES "districts" ("id")
    `);

    await queryRunner.query(`
      UPDATE "listings" l
         SET "city_id" = c."id", "district_id" = d."id"
        FROM "cities" c
        JOIN "districts" d ON d."city_id" = c."id"
       WHERE l."city" = c."name" AND l."district" = d."name"
    `);

    // Bước 3: một khối DO xóa ảnh rồi xóa tin; RAISE NOTICE số đã xóa (hiện trong log migration)
    await queryRunner.query(`
      DO $$
      DECLARE
        n_images int;
        n_listings int;
      BEGIN
        DELETE FROM "listing_images"
         WHERE "listing_id" IN (SELECT "id" FROM "listings" WHERE "city_id" IS NULL OR "district_id" IS NULL);
        GET DIAGNOSTICS n_images = ROW_COUNT;
        DELETE FROM "listings" WHERE "city_id" IS NULL OR "district_id" IS NULL;
        GET DIAGNOSTICS n_listings = ROW_COUNT;
        RAISE NOTICE 'ListingsLocationIds: đã xóa % tin và % ảnh không ánh xạ được vào danh mục địa giới', n_listings, n_images;
      END $$
    `);

    await queryRunner.query(`
      ALTER TABLE "listings"
        ALTER COLUMN "city_id" SET NOT NULL,
        ALTER COLUMN "district_id" SET NOT NULL
    `);

    await queryRunner.query(`DROP INDEX "ix_listings_search"`);
    await queryRunner.query(`ALTER TABLE "listings" DROP COLUMN "district", DROP COLUMN "city"`);
    await queryRunner.query(
      `CREATE INDEX "ix_listings_search" ON "listings" ("approval_status", "status", "district_id") WHERE "deleted_at" IS NULL`,
    );
    await queryRunner.query(
      `CREATE INDEX "ix_listings_city" ON "listings" ("approval_status", "status", "city_id") WHERE "deleted_at" IS NULL`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX "ix_listings_city"`);
    await queryRunner.query(`DROP INDEX "ix_listings_search"`);
    await queryRunner.query(`
      ALTER TABLE "listings"
        ADD COLUMN "district" character varying(100),
        ADD COLUMN "city" character varying(100)
    `);
    await queryRunner.query(`
      UPDATE "listings" l
         SET "city" = c."name", "district" = d."name"
        FROM "cities" c, "districts" d
       WHERE c."id" = l."city_id" AND d."id" = l."district_id"
    `);
    await queryRunner.query(
      `CREATE INDEX "ix_listings_search" ON "listings" ("approval_status", "status", "district") WHERE "deleted_at" IS NULL`,
    );
    await queryRunner.query(`
      ALTER TABLE "listings"
        DROP CONSTRAINT "FK_listings_district",
        DROP CONSTRAINT "FK_listings_city",
        DROP COLUMN "district_id",
        DROP COLUMN "city_id"
    `);
  }
}
