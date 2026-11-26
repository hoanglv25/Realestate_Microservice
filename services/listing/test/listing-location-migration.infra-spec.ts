import { randomUUID } from 'node:crypto';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { Client } from 'pg';
import { DataSource } from 'typeorm';
import { INFRA_TEST_SCHEMA } from './helpers/infra';

/**
 * Migration v1.5 `1733300000000-listings-location-ids` (`RE.LISTING/API_Spec.md §6.1`, test 25) và
 * `down` của `1733200000000-create-locations` (`RE.LOCATION` test 7) trên Postgres + PostGIS THẬT.
 *
 * Dựng dữ liệu ở trạng thái TRƯỚC v1.5 (còn cột chuỗi `city`, `district`), chạy migration rồi kiểm:
 * tin khớp tên có id, tin không khớp bị xóa cứng cùng ảnh, cột id `NOT NULL`, cột chuỗi đã bỏ; `down`
 * khôi phục cột chuỗi đúng tên.
 */
const MIGRATIONS_DIR = join(__dirname, '..', 'src', 'database', 'migrations');
const V15 = '1733300000000-listings-location-ids';

function dataSource(migrations: string[]): DataSource {
  return new DataSource({ type: 'postgres', url: process.env.DATABASE_URL, migrations });
}

describe('Migration địa giới (v1.5) với Postgres thật', () => {
  let pg: Client;
  const owner = randomUUID();

  const columns = async (table: string) =>
    (
      await pg.query<{ column_name: string; is_nullable: string }>(
        `SELECT column_name, is_nullable FROM information_schema.columns
          WHERE table_schema = $1 AND table_name = $2`,
        [INFRA_TEST_SCHEMA, table],
      )
    ).rows;
  const indexDef = async (name: string) =>
    (
      await pg.query<{ indexdef: string }>(
        `SELECT indexdef FROM pg_indexes WHERE schemaname = $1 AND indexname = $2`,
        [INFRA_TEST_SCHEMA, name],
      )
    ).rows[0]?.indexdef;
  const tableExists = async (name: string) =>
    (
      await pg.query(
        `SELECT 1 FROM information_schema.tables WHERE table_schema = $1 AND table_name = $2`,
        [INFRA_TEST_SCHEMA, name],
      )
    ).rowCount === 1;

  /** Chèn tin theo DDL TRƯỚC v1.5 (cột chuỗi). */
  async function legacyListing(title: string, city: string, district: string, deleted = false) {
    const res = await pg.query<{ id: string }>(
      `INSERT INTO listings (owner_id, title, property_type, price_vnd, deposit_amount_vnd, area_m2,
                             address, district, city, location, deleted_at)
       VALUES ($1, $2, 'ROOM', 3000000, 3000000, 20, 'x', $3, $4,
               ST_SetSRID(ST_MakePoint(105.84, 21.0), 4326)::geography, CASE WHEN $5 THEN now() END)
       RETURNING id`,
      [owner, title, district, city, deleted],
    );
    return res.rows[0].id;
  }
  const addImage = (listingId: string) =>
    pg.query(`INSERT INTO listing_images (listing_id, object_key) VALUES ($1, $2)`, [
      listingId,
      `listings/${listingId}/${randomUUID()}.png`,
    ]);

  beforeAll(async () => {
    pg = new Client({ connectionString: process.env.DATABASE_URL });
    await pg.connect();
    await pg.query(`DROP SCHEMA IF EXISTS ${INFRA_TEST_SCHEMA} CASCADE`);
    await pg.query(`CREATE SCHEMA ${INFRA_TEST_SCHEMA}`);
  });

  afterAll(async () => {
    await pg?.query(`DROP SCHEMA IF EXISTS ${INFRA_TEST_SCHEMA} CASCADE`).catch(() => undefined);
    await pg?.end();
  });

  it('Test 25 (RE.LISTING) và test 7 (RE.LOCATION): up ánh xạ, xóa tin không khớp; down khôi phục', async () => {
    // 1. Chạy mọi migration TRỪ v1.5
    const files = readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.ts'));
    expect(files).toContain(`${V15}.ts`);
    const pre = dataSource(
      files.filter((f) => !f.startsWith(V15)).map((f) => join(MIGRATIONS_DIR, f)),
    );
    await pre.initialize();
    await pre.runMigrations();
    await pre.destroy();
    expect((await columns('listings')).map((c) => c.column_name)).toEqual(
      expect.arrayContaining(['city', 'district']),
    );

    // 2. Dữ liệu cũ: khớp (có ảnh), tỉnh không có trong danh mục (có ảnh), quận sai tỉnh, đã xóa mềm không khớp
    const matched = await legacyListing('Khớp', 'Hà Nội', 'Hai Bà Trưng');
    await addImage(matched);
    const otherCity = await legacyListing('Tỉnh ngoài danh mục', 'Hải Phòng', 'Lê Chân');
    await addImage(otherCity);
    await addImage(otherCity);
    const wrongPair = await legacyListing('Quận sai tỉnh', 'Hồ Chí Minh', 'Hai Bà Trưng');
    const deletedBad = await legacyListing('Đã xóa mềm, không khớp', 'Hà Nội', 'Quận 99', true);
    const nullNames = await pg.query<{ id: string }>(
      `INSERT INTO listings (owner_id, title, property_type, price_vnd, deposit_amount_vnd, area_m2, location)
       VALUES ($1, 'Thiếu địa chỉ', 'ROOM', 1, 1, 1, ST_SetSRID(ST_MakePoint(105.84, 21.0), 4326)::geography)
       RETURNING id`,
      [owner],
    );

    // 3. Chạy v1.5
    const ds = dataSource([join(MIGRATIONS_DIR, '*.ts')]);
    await ds.initialize();
    await ds.runMigrations();

    const rows = (
      await pg.query<{
        id: string;
        city_id: string;
        district_id: string;
        city: string;
        district: string;
      }>(
        `SELECT l.id, l.city_id, l.district_id, c.name AS city, d.name AS district
           FROM listings l JOIN cities c ON c.id = l.city_id JOIN districts d ON d.id = l.district_id`,
      )
    ).rows;
    expect(rows).toEqual([
      expect.objectContaining({ id: matched, city: 'Hà Nội', district: 'Hai Bà Trưng' }),
    ]);
    for (const gone of [otherCity, wrongPair, deletedBad, nullNames.rows[0].id]) {
      expect((await pg.query(`SELECT 1 FROM listings WHERE id = $1`, [gone])).rowCount).toBe(0);
      expect(
        (await pg.query(`SELECT 1 FROM listing_images WHERE listing_id = $1`, [gone])).rowCount,
      ).toBe(0);
    }
    expect(
      (await pg.query(`SELECT 1 FROM listing_images WHERE listing_id = $1`, [matched])).rowCount,
    ).toBe(1);

    const cols = await columns('listings');
    expect(cols.map((c) => c.column_name)).not.toContain('city');
    expect(cols.map((c) => c.column_name)).not.toContain('district');
    expect(cols.find((c) => c.column_name === 'city_id')?.is_nullable).toBe('NO');
    expect(cols.find((c) => c.column_name === 'district_id')?.is_nullable).toBe('NO');
    expect(await indexDef('ix_listings_search')).toContain(
      '(approval_status, status, district_id)',
    );
    expect(await indexDef('ix_listings_city')).toContain('(approval_status, status, city_id)');
    await expect(
      pg.query(`UPDATE listings SET district_id = $2 WHERE id = $1`, [matched, randomUUID()]),
    ).rejects.toThrow(/foreign key/);

    // 4. down v1.5: cột chuỗi trở lại với đúng tên cho tin còn lại
    await ds.undoLastMigration();
    const restored = await pg.query<{ city: string; district: string }>(
      `SELECT city, district FROM listings WHERE id = $1`,
      [matched],
    );
    expect(restored.rows[0]).toEqual({ city: 'Hà Nội', district: 'Hai Bà Trưng' });
    expect((await columns('listings')).map((c) => c.column_name)).not.toContain('city_id');
    expect(await indexDef('ix_listings_search')).toContain('(approval_status, status, district)');
    expect(await indexDef('ix_listings_city')).toBeUndefined();

    // 5. down create-locations (RE.LOCATION test 7): hai bảng biến mất; up lại thì đủ dữ liệu
    await ds.undoLastMigration();
    expect(await tableExists('districts')).toBe(false);
    expect(await tableExists('cities')).toBe(false);
    await ds.runMigrations();
    expect(
      (await pg.query<{ n: number }>(`SELECT count(*)::int AS n FROM districts`)).rows[0].n,
    ).toBe(80);
    await ds.destroy();
  });
});
