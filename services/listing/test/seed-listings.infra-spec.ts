import { plainToInstance } from 'class-transformer';
import { join } from 'node:path';
import { Client } from 'pg';
import { DataSource } from 'typeorm';
import { SearchListingsQuery } from '../src/listing/dto/search-listings.query';
import { buildSearchSql } from '../src/listing/services/listing-search.sql';
import { SEED_LISTINGS } from '../src/listing/seed/seed-listings.data';
import { seedListings } from '../src/listing/seed/seed-listings';
import { INFRA_TEST_SCHEMA } from './helpers/infra';
import { haversineM } from './helpers/listing-fixtures';

/**
 * seedListings với Postgres + PostGIS THẬT (schema riêng của test trong listing_db, xóa ở cuối).
 * Không cần Redis, RabbitMQ, S3: script seed không khởi động NestJS.
 */
const CENTER = { lat: 21.0, lng: 105.84 };

describe('seedListings với Postgres thật', () => {
  let pg: Client;
  let ds: DataSource;

  const search = async (query: Record<string, string>) => {
    const built = buildSearchSql(plainToInstance(SearchListingsQuery, query));
    const rows = (await pg.query(built.dataSql, built.dataParams)).rows as Array<{
      id: string;
      distanceM?: number;
    }>;
    const total = Number((await pg.query(built.countSql, built.countParams)).rows[0].total);
    return { rows, total };
  };

  beforeAll(async () => {
    pg = new Client({ connectionString: process.env.DATABASE_URL });
    await pg.connect();
    await pg.query(`DROP SCHEMA IF EXISTS ${INFRA_TEST_SCHEMA} CASCADE`);
    await pg.query(`CREATE SCHEMA ${INFRA_TEST_SCHEMA}`);
    ds = new DataSource({
      type: 'postgres',
      url: process.env.DATABASE_URL,
      migrations: [join(__dirname, '..', 'src', 'database', 'migrations', '*.ts')],
    });
    await ds.initialize();
    await ds.runMigrations();
  });

  beforeEach(async () => {
    await pg.query('TRUNCATE listing_images, listings CASCADE');
  });

  afterAll(async () => {
    await ds?.destroy();
    await pg?.query(`DROP SCHEMA IF EXISTS ${INFRA_TEST_SCHEMA} CASCADE`).catch(() => undefined);
    await pg?.end();
  });

  it('lần đầu tạo 30 tin đúng id, chủ trọ, trạng thái, tọa độ', async () => {
    await expect(seedListings(ds)).resolves.toEqual({ created: 30, existing: 0 });

    const rows = (
      await pg.query(
        `SELECT id, owner_id, title, property_type, price_vnd::float8 AS price, deposit_amount_vnd::float8 AS deposit,
                area_m2::float8 AS area,
                (SELECT name FROM districts WHERE id = district_id) AS district,
                (SELECT name FROM cities WHERE id = city_id) AS city,
                amenities, status, approval_status, reject_reason,
                reviewed_at, held_until, held_by_deposit_id, deleted_at,
                ST_Y(location::geometry) AS lat, ST_X(location::geometry) AS lng
           FROM listings ORDER BY id`,
      )
    ).rows;
    expect(rows).toHaveLength(30);
    for (const seed of SEED_LISTINGS) {
      const row = rows.find((r) => r.id === seed.id);
      expect(row).toMatchObject({
        owner_id: seed.ownerId,
        title: seed.title,
        property_type: seed.propertyType,
        price: seed.priceVnd,
        deposit: seed.depositAmountVnd,
        area: seed.areaM2,
        district: seed.district,
        city: 'Hà Nội',
        amenities: seed.amenities,
        status: seed.status,
        approval_status: seed.approvalStatus,
        held_until: null,
        held_by_deposit_id: null,
        deleted_at: null,
      });
      expect(row.lat).toBeCloseTo(seed.lat, 6);
      expect(row.lng).toBeCloseTo(seed.lng, 6);
      expect(row.reject_reason).toBe(seed.rejectReason ?? null);
      // duyệt rồi (APPROVED, REJECTED) thì có reviewed_at; chưa duyệt thì không
      expect(row.reviewed_at !== null).toBe(seed.approvalStatus !== 'PENDING_REVIEW');
    }
  });

  it('v1.5: tin seed có city_id, district_id trỏ đúng danh mục RE.LOCATION', async () => {
    await seedListings(ds);
    const { rows } = await pg.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM listings l
         JOIN districts d ON d.id = l.district_id AND d.city_id = l.city_id`,
    );
    expect(rows[0].n).toBe(30);
  });

  it('v1.5: tên quận không có trong danh mục → seed lỗi, hoàn tác (không tạo tin nào)', async () => {
    await seedListings(ds);
    // 29 tin đã có (ON CONFLICT bỏ qua); xóa tin cuối và đổi tên quận của nó để đi tới INSERT mới
    await pg.query(`DELETE FROM listings WHERE id = $1`, [SEED_LISTINGS[29].id]);
    const before = await pg.query<{ n: number }>(`SELECT count(*)::int AS n FROM listings`);
    const last = SEED_LISTINGS[29] as { district: string };
    const saved = last.district;
    last.district = 'Quận Không Tồn Tại';
    try {
      await expect(seedListings(ds)).rejects.toThrow();
    } finally {
      last.district = saved;
    }
    const after = await pg.query<{ n: number }>(`SELECT count(*)::int AS n FROM listings`);
    expect(after.rows[0].n).toBe(before.rows[0].n);
    await expect(seedListings(ds)).resolves.toEqual({ created: 1, existing: 29 });
  });

  it('chạy lại: created 0, existing 30, không đổi dữ liệu', async () => {
    await seedListings(ds);
    const before = (await pg.query(`SELECT * FROM listings ORDER BY id`)).rows;

    await expect(seedListings(ds)).resolves.toEqual({ created: 0, existing: 30 });

    const after = (await pg.query(`SELECT * FROM listings ORDER BY id`)).rows;
    expect(after).toEqual(before);
  });

  it('KHÔNG ghi đè tin đã bị sửa sau khi seed; chỉ bổ sung tin còn thiếu', async () => {
    await seedListings(ds);
    const edited = SEED_LISTINGS[0].id;
    const missing = SEED_LISTINGS[29].id;
    await pg.query(`UPDATE listings SET title = 'Đã sửa tay', status = 'DEPOSITED' WHERE id = $1`, [
      edited,
    ]);
    await pg.query(`DELETE FROM listings WHERE id = $1`, [missing]);

    await expect(seedListings(ds)).resolves.toEqual({ created: 1, existing: 29 });

    const row = (await pg.query(`SELECT title, status FROM listings WHERE id = $1`, [edited]))
      .rows[0];
    expect(row).toEqual({ title: 'Đã sửa tay', status: 'DEPOSITED' });
    expect((await pg.query(`SELECT 1 FROM listings WHERE id = $1`, [missing])).rowCount).toBe(1);
  });

  it('5 lần chạy đồng thời: tổng created đúng 30, đúng 30 dòng', async () => {
    const results = await Promise.allSettled(Array.from({ length: 5 }, () => seedListings(ds)));
    const ok = results.filter(
      (r): r is PromiseFulfilledResult<{ created: number; existing: number }> =>
        r.status === 'fulfilled',
    );
    expect(ok.length).toBeGreaterThanOrEqual(1);
    expect(ok.reduce((sum, r) => sum + r.value.created, 0)).toBe(30);
    expect((await pg.query(`SELECT 1 FROM listings`)).rowCount).toBe(30);
  });

  it('created_at khác nhau: sort mặc định (newest) trả tin số 1 trước', async () => {
    await seedListings(ds);
    const { rows } = await search({ pageSize: '50' });
    // tin 1 là APPROVED+AVAILABLE, mới nhất trong các tin tìm thấy được
    expect(rows[0].id).toBe(SEED_LISTINGS[0].id);
  });

  describe('tìm kiếm route 11 trên dữ liệu seed', () => {
    beforeEach(async () => {
      await seedListings(ds);
      await pg.query('ANALYZE listings');
    });

    const idsWithin = (maxM: number, minM = 0) =>
      SEED_LISTINGS.filter((l) => {
        const d = haversineM(CENTER, l);
        return d >= minM && d <= maxM && l.approvalStatus === 'APPROVED' && l.status !== 'HIDDEN';
      }).map((l) => l.id);

    it('bán kính 2 km: đúng tập APPROVED, không HIDDEN, không PENDING_REVIEW, sắp theo khoảng cách', async () => {
      const { rows, total } = await search({
        lat: String(CENTER.lat),
        lng: String(CENTER.lng),
        radiusKm: '2',
        sort: 'distance',
        pageSize: '50',
      });
      const want = idsWithin(2000);
      expect([...rows.map((r) => r.id)].sort()).toEqual([...want].sort());
      expect(total).toBe(want.length);
      expect(want.length).toBeGreaterThanOrEqual(10);

      const distances = rows.map((r) => r.distanceM as number);
      expect(distances).toEqual([...distances].sort((a, b) => a - b));
      for (const r of rows) {
        const seed = SEED_LISTINGS.find((l) => l.id === r.id)!;
        const want = haversineM(CENTER, seed);
        // PostGIS tính trên spheroid, haversine trên mặt cầu: lệch dưới 0,5%
        expect(Math.abs((r.distanceM as number) - want)).toBeLessThan(want * 0.005 + 1);
      }

      // tin PENDING_REVIEW và HIDDEN nằm trong 2 km nhưng bị loại
      const excluded = SEED_LISTINGS.filter(
        (l) =>
          haversineM(CENTER, l) <= 2000 &&
          (l.approvalStatus === 'PENDING_REVIEW' || l.status === 'HIDDEN'),
      ).map((l) => l.id);
      expect(excluded.length).toBeGreaterThanOrEqual(2);
      for (const id of excluded) expect(rows.map((r) => r.id)).not.toContain(id);
    });

    it('bán kính 3 km: thêm đúng các tin ở 2,1–3 km', async () => {
      const r2 = await search({
        lat: String(CENTER.lat),
        lng: String(CENTER.lng),
        radiusKm: '2',
        pageSize: '50',
      });
      const r3 = await search({
        lat: String(CENTER.lat),
        lng: String(CENTER.lng),
        radiusKm: '3',
        pageSize: '50',
      });
      const added = r3.rows.map((r) => r.id).filter((id) => !r2.rows.some((x) => x.id === id));
      expect([...added].sort()).toEqual([...idsWithin(3000, 2000)].sort());
      expect(added.length).toBeGreaterThanOrEqual(2);
      expect(added.length).toBeLessThanOrEqual(3);
    });

    it('không lọc bán kính: 25 tin tìm thấy được (30 trừ 3 PENDING_REVIEW, 1 REJECTED, 1 HIDDEN)', async () => {
      const { total } = await search({ pageSize: '50' });
      // 24 AVAILABLE+APPROVED + 1 RENTED; 3 PENDING_REVIEW, 1 REJECTED, 1 HIDDEN bị loại
      expect(total).toBe(25);
    });

    it('EXPLAIN bán kính 2 km trên seed thật: in plan (với ~30 dòng planner có thể chọn Seq Scan)', async () => {
      const plan = await pg.query(
        `EXPLAIN SELECT id FROM listings
          WHERE ST_DWithin(location, ST_MakePoint(105.84, 21.00)::geography, 2000)`,
      );
      const text = plan.rows.map((r) => r['QUERY PLAN'] as string).join('\n');
      // Không khẳng định Seq Scan hay Index Scan (DoD T2.4): chỉ cần câu lệnh chạy được và có plan.
      // Việc dùng ix_listings_location đã được chứng minh ở listing-search.infra-spec.ts (~5.000 dòng).
      expect(text).toMatch(/Scan on listings/);
      console.log(`EXPLAIN bán kính 2 km trên seed (30 dòng):\n${text}`);
    });
  });
});
