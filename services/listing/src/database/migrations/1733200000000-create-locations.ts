import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Danh mục tỉnh/thành, quận/huyện (`RE.LOCATION/API_Spec.md §6`, ADR-0015): hai bảng chỉ đọc và dữ liệu
 * nạp sẵn. Địa giới 3 cấp TRƯỚC 1/7/2025; tên bỏ tiền tố loại đơn vị (trừ quận đánh số), dạng NFC.
 *
 * Nguồn đối chiếu (2026-11-26, T2.6):
 * - Bình Dương: QĐ 790/QĐ-TTg ngày 03/8/2024 (5 thành phố, 4 huyện).
 * - Đồng Nai: QĐ 586/QĐ-TTg ngày 03/7/2024 (2 thành phố, 9 huyện).
 * - Hồ Chí Minh: 16 quận, TP Thủ Đức, 5 huyện (NQ 1111/NQ-UBTVQH14, từ 01/01/2021).
 * - Đà Nẵng: 6 quận, 2 huyện. Hà Nội: 12 quận, 1 thị xã, 17 huyện.
 *
 * `sort_order` theo thứ tự trong mảng: quận → thị xã/thành phố thuộc tỉnh → huyện, mỗi nhóm theo ABC.
 * Id sinh bằng `gen_random_uuid()` nên khác nhau giữa các môi trường (client lấy qua API, không ghi cứng).
 * Thêm tỉnh: viết migration mới, không sửa migration này.
 */
const LOCATIONS: ReadonlyArray<readonly [city: string, districts: readonly string[]]> = [
  [
    'Hà Nội',
    [
      // 12 quận
      'Ba Đình',
      'Bắc Từ Liêm',
      'Cầu Giấy',
      'Đống Đa',
      'Hà Đông',
      'Hai Bà Trưng',
      'Hoàn Kiếm',
      'Hoàng Mai',
      'Long Biên',
      'Nam Từ Liêm',
      'Tây Hồ',
      'Thanh Xuân',
      // 1 thị xã
      'Sơn Tây',
      // 17 huyện
      'Ba Vì',
      'Chương Mỹ',
      'Đan Phượng',
      'Đông Anh',
      'Gia Lâm',
      'Hoài Đức',
      'Mê Linh',
      'Mỹ Đức',
      'Phú Xuyên',
      'Phúc Thọ',
      'Quốc Oai',
      'Sóc Sơn',
      'Thạch Thất',
      'Thanh Oai',
      'Thanh Trì',
      'Thường Tín',
      'Ứng Hòa',
    ],
  ],
  [
    'Hồ Chí Minh',
    [
      // 16 quận
      'Quận 1',
      'Quận 3',
      'Quận 4',
      'Quận 5',
      'Quận 6',
      'Quận 7',
      'Quận 8',
      'Quận 10',
      'Quận 11',
      'Quận 12',
      'Bình Tân',
      'Bình Thạnh',
      'Gò Vấp',
      'Phú Nhuận',
      'Tân Bình',
      'Tân Phú',
      // thành phố thuộc thành phố
      'Thủ Đức',
      // 5 huyện
      'Bình Chánh',
      'Cần Giờ',
      'Củ Chi',
      'Hóc Môn',
      'Nhà Bè',
    ],
  ],
  [
    'Đà Nẵng',
    [
      // 6 quận
      'Cẩm Lệ',
      'Hải Châu',
      'Liên Chiểu',
      'Ngũ Hành Sơn',
      'Sơn Trà',
      'Thanh Khê',
      // 2 huyện
      'Hòa Vang',
      'Hoàng Sa',
    ],
  ],
  [
    'Bình Dương',
    [
      // 5 thành phố
      'Bến Cát',
      'Dĩ An',
      'Tân Uyên',
      'Thủ Dầu Một',
      'Thuận An',
      // 4 huyện
      'Bàu Bàng',
      'Bắc Tân Uyên',
      'Dầu Tiếng',
      'Phú Giáo',
    ],
  ],
  [
    'Đồng Nai',
    [
      // 2 thành phố
      'Biên Hòa',
      'Long Khánh',
      // 9 huyện
      'Cẩm Mỹ',
      'Định Quán',
      'Long Thành',
      'Nhơn Trạch',
      'Tân Phú',
      'Thống Nhất',
      'Trảng Bom',
      'Vĩnh Cửu',
      'Xuân Lộc',
    ],
  ],
];

export class CreateLocations1733200000000 implements MigrationInterface {
  name = 'CreateLocations1733200000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "cities" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "name" character varying(100) NOT NULL,
        "sort_order" smallint NOT NULL,
        "created_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
        CONSTRAINT "PK_cities" PRIMARY KEY ("id"),
        CONSTRAINT "uq_cities_name" UNIQUE ("name")
      )
    `);
    await queryRunner.query(`CREATE INDEX "ix_cities_sort" ON "cities" ("sort_order", "id")`);

    await queryRunner.query(`
      CREATE TABLE "districts" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "city_id" uuid NOT NULL,
        "name" character varying(100) NOT NULL,
        "sort_order" smallint NOT NULL,
        "created_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
        CONSTRAINT "PK_districts" PRIMARY KEY ("id"),
        CONSTRAINT "uq_districts_city_name" UNIQUE ("city_id", "name"),
        CONSTRAINT "FK_districts_city" FOREIGN KEY ("city_id") REFERENCES "cities" ("id")
      )
    `);
    await queryRunner.query(
      `CREATE INDEX "ix_districts_city" ON "districts" ("city_id", "sort_order", "id")`,
    );

    // Hai câu INSERT cho cả danh mục (unnest mảng tham số), không lặp truy vấn theo từng dòng
    const cityNames = LOCATIONS.map(([city]) => city.normalize('NFC'));
    await queryRunner.query(
      `INSERT INTO "cities" ("name", "sort_order")
       SELECT name, ord::smallint FROM unnest($1::text[]) WITH ORDINALITY AS t(name, ord)`,
      [cityNames],
    );
    const pairs = LOCATIONS.flatMap(([city, districts]) =>
      districts.map((d, i) => [city.normalize('NFC'), d.normalize('NFC'), i + 1] as const),
    );
    await queryRunner.query(
      `INSERT INTO "districts" ("city_id", "name", "sort_order")
       SELECT c.id, t.name, t.ord::smallint
         FROM unnest($1::text[], $2::text[], $3::int[]) AS t(city, name, ord)
         JOIN "cities" c ON c.name = t.city`,
      [pairs.map((p) => p[0]), pairs.map((p) => p[1]), pairs.map((p) => p[2])],
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE "districts"`);
    await queryRunner.query(`DROP TABLE "cities"`);
  }
}
