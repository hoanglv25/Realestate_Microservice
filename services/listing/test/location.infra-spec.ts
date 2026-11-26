import { randomUUID } from 'node:crypto';
import { Client } from 'pg';
import { DataSource } from 'typeorm';
import { SEED_LISTINGS } from '../src/listing/seed/seed-listings.data';
import { LocationQueryService } from '../src/listing/services/location-query.service';
import { StorageService } from '../src/storage/storage.service';
import type { TestApp } from './helpers/create-test-app';
import { INFRA_TEST_SCHEMA, readRootEnv } from './helpers/infra';

/**
 * Danh mục tỉnh/thành, quận/huyện (`RE.LOCATION`) với Postgres + PostGIS THẬT: migration nạp dữ liệu,
 * `GET /api/v1/cities`, `GET /api/v1/districts`, `LocationQueryService.isDistrictInCity`.
 * Test 1–4, 6, 8, 9 ở `RE.LOCATION/Component_Class_Design.md §3` (test 5: unit DTO + e2e; test 7:
 * `listing-location-migration.infra-spec.ts`).
 *
 * Dữ liệu mong đợi viết lại độc lập ở đây (không đọc từ migration) để test bắt được migration sai.
 */
const BUCKET = 'listing-images';
const ENV_NAMES = [
  'S3_ENDPOINT',
  'S3_PUBLIC_ENDPOINT',
  'S3_ACCESS_KEY',
  'S3_SECRET_KEY',
  'S3_BUCKETS',
];

const CITIES = ['Hà Nội', 'Hồ Chí Minh', 'Đà Nẵng', 'Bình Dương', 'Đồng Nai'];
const HA_NOI = [
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
  'Sơn Tây',
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
];
const COUNT_BY_CITY: Record<string, number> = {
  'Hà Nội': 30,
  'Hồ Chí Minh': 22,
  'Đà Nẵng': 8,
  'Bình Dương': 9,
  'Đồng Nai': 11,
};

interface CityBody {
  id: string;
  name: string;
}
interface DistrictBody {
  id: string;
  cityId: string;
  name: string;
}

describe('Danh mục tỉnh/thành, quận/huyện với hạ tầng thật', () => {
  let t: TestApp;
  let pg: Client;
  let ds: DataSource;
  const queries: string[] = [];
  const cityId = new Map<string, string>(); // tên → id

  const get = (path: string) => t.http().get(path); // không gắn token: route public

  async function countQueries(call: () => Promise<unknown>): Promise<number> {
    queries.length = 0;
    await call();
    return queries.filter((q) => !/^(START TRANSACTION|COMMIT|ROLLBACK)/i.test(q)).length;
  }

  beforeAll(async () => {
    const root = readRootEnv();
    pg = new Client({ connectionString: process.env.DATABASE_URL });
    await pg.connect();
    await pg.query(`DROP SCHEMA IF EXISTS ${INFRA_TEST_SCHEMA} CASCADE`);
    await pg.query(`CREATE SCHEMA ${INFRA_TEST_SCHEMA}`);
    const s3 = `http://localhost:${root.S3_API_PORT ?? '9000'}`;
    Object.assign(process.env, {
      S3_ENDPOINT: s3,
      S3_PUBLIC_ENDPOINT: s3,
      S3_ACCESS_KEY: root.S3_ACCESS_KEY,
      S3_SECRET_KEY: root.S3_SECRET_KEY,
      S3_BUCKETS: BUCKET,
    });
    const { createTestApp } = await import('./helpers/create-test-app');
    t = await createTestApp();
    ds = t.app.get(DataSource);
    await t.app.get(StorageService).bucketsReady;
    await ds.runMigrations();
    const { rows } = await pg.query<{ id: string; name: string }>(
      `SELECT id, name FROM ${INFRA_TEST_SCHEMA}.cities`,
    );
    rows.forEach((r) => cityId.set(r.name, r.id));
    const noop = () => undefined;
    (ds as unknown as { logger: unknown }).logger = {
      logQuery: (q: string) => queries.push(q),
      logQueryError: noop,
      logQuerySlow: noop,
      logSchemaBuild: noop,
      logMigration: noop,
      log: noop,
    };
  });

  afterAll(async () => {
    await t?.app.close();
    await pg?.query(`DROP SCHEMA IF EXISTS ${INFRA_TEST_SCHEMA} CASCADE`).catch(() => undefined);
    await pg?.end();
    for (const name of ENV_NAMES) delete process.env[name];
  });

  describe('Test 6: dữ liệu nạp bởi migration', () => {
    it('5 tỉnh, 80 quận/huyện, đúng số theo tỉnh, không trùng (city_id, name)', async () => {
      const { rows } = await pg.query<{ city: string; n: number; distinct_names: number }>(
        `SELECT c.name AS city, count(d.id)::int AS n, count(DISTINCT d.name)::int AS distinct_names
           FROM ${INFRA_TEST_SCHEMA}.cities c
           LEFT JOIN ${INFRA_TEST_SCHEMA}.districts d ON d.city_id = c.id
          GROUP BY c.name`,
      );
      expect(rows).toHaveLength(5);
      for (const r of rows) {
        expect(r.n).toBe(COUNT_BY_CITY[r.city]);
        expect(r.distinct_names).toBe(r.n);
      }
      expect(rows.reduce((sum, r) => sum + r.n, 0)).toBe(80);
    });

    it('mọi tên quận, tỉnh của seed RE.LISTING có trong danh mục (seed và migration v1.5 ánh xạ được)', async () => {
      const { rows } = await pg.query<{ city: string; district: string }>(
        `SELECT c.name AS city, d.name AS district
           FROM ${INFRA_TEST_SCHEMA}.districts d JOIN ${INFRA_TEST_SCHEMA}.cities c ON c.id = d.city_id`,
      );
      const known = new Set(rows.map((r) => `${r.city}|${r.district}`));
      for (const l of SEED_LISTINGS) expect(known).toContain(`${l.city}|${l.district}`);
    });

    it('tên ở dạng Unicode NFC, không có khoảng trắng thừa', async () => {
      const { rows } = await pg.query<{ name: string }>(
        `SELECT name FROM ${INFRA_TEST_SCHEMA}.cities UNION ALL SELECT name FROM ${INFRA_TEST_SCHEMA}.districts`,
      );
      for (const { name } of rows) {
        expect(name).toBe(name.normalize('NFC'));
        expect(name).toBe(name.trim());
      }
    });
  });

  describe('Route 1: GET /api/v1/cities', () => {
    it('Test 1: không token → 200, 5 tỉnh theo sort_order, total 5', async () => {
      const res = await get('/api/v1/cities?pageSize=50');
      expect(res.status).toBe(200);
      expect((res.body.data as CityBody[]).map((c) => c.name)).toEqual(CITIES);
      expect(res.body.meta).toMatchObject({ page: 1, pageSize: 50, total: 5, totalPages: 1 });
      expect(Object.keys(res.body.data[0]).sort()).toEqual(['id', 'name']);
    });

    it('mặc định page 1, pageSize 20', async () => {
      const res = await get('/api/v1/cities');
      expect(res.status).toBe(200);
      expect(res.body.meta).toMatchObject({ page: 1, pageSize: 20, total: 5 });
    });
  });

  describe('Route 2: GET /api/v1/districts', () => {
    it('Test 2: Hà Nội, pageSize 50 → 30 quận/huyện đúng thứ tự, cùng cityId', async () => {
      const id = cityId.get('Hà Nội');
      const res = await get(`/api/v1/districts?cityId=${id}&pageSize=50`);
      expect(res.status).toBe(200);
      const data = res.body.data as DistrictBody[];
      expect(data.map((d) => d.name)).toEqual(HA_NOI);
      expect(new Set(data.map((d) => d.cityId))).toEqual(new Set([id]));
      expect(Object.keys(data[0]).sort()).toEqual(['cityId', 'id', 'name']);
      expect(res.body.meta).toMatchObject({ total: 30, totalPages: 1 });
    });

    it('Test 3: pageSize 10, page 2 → phần tử 11–20, totalPages 3', async () => {
      const res = await get(`/api/v1/districts?cityId=${cityId.get('Hà Nội')}&pageSize=10&page=2`);
      expect(res.status).toBe(200);
      expect((res.body.data as DistrictBody[]).map((d) => d.name)).toEqual(HA_NOI.slice(10, 20));
      expect(res.body.meta).toMatchObject({ page: 2, pageSize: 10, total: 30, totalPages: 3 });
    });

    it('Test 4: cityId là UUID không có → 200, rỗng, total 0', async () => {
      const res = await get(`/api/v1/districts?cityId=${randomUUID()}`);
      expect(res.status).toBe(200);
      expect(res.body.data).toEqual([]);
      expect(res.body.meta).toMatchObject({ total: 0 });
    });

    it.each([
      ['thiếu cityId', '', 'cityId'],
      ['cityId sai dạng', 'cityId=abc', 'cityId'],
    ])('Test 5: %s → 400 VALIDATION_FAILED', async (_name, qs, field) => {
      const res = await get(`/api/v1/districts?${qs}`);
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_FAILED');
      expect(res.body.error.details.map((d: { field: string }) => d.field)).toContain(field);
    });

    it('mỗi tỉnh trả đúng số quận/huyện', async () => {
      for (const [name, n] of Object.entries(COUNT_BY_CITY)) {
        const res = await get(`/api/v1/districts?cityId=${cityId.get(name)}&pageSize=50`);
        expect(res.body.meta.total).toBe(n);
      }
    });
  });

  describe('Test 8: isDistrictInCity', () => {
    it('cặp đúng → true; quận của tỉnh khác → false; id không có → false', async () => {
      const service = t.app.get(LocationQueryService);
      const hn = cityId.get('Hà Nội')!;
      const hcm = cityId.get('Hồ Chí Minh')!;
      const { rows } = await pg.query<{ id: string }>(
        `SELECT id FROM ${INFRA_TEST_SCHEMA}.districts WHERE city_id = $1 AND name = 'Ba Đình'`,
        [hn],
      );
      const baDinh = rows[0].id;
      await expect(service.isDistrictInCity(hn, baDinh)).resolves.toBe(true);
      await expect(service.isDistrictInCity(hcm, baDinh)).resolves.toBe(false);
      await expect(service.isDistrictInCity(hn, randomUUID())).resolves.toBe(false);
    });
  });

  describe('Test 9: số truy vấn', () => {
    // findAndCount bỏ câu count khi trang đầu ít hơn pageSize, nên 1–2 câu (thiết kế: tối đa 2, ngưỡng 4)
    it('GET /cities, GET /districts: tối đa 2; isDistrictInCity: 1', async () => {
      expect(await countQueries(() => get('/api/v1/cities'))).toBeLessThanOrEqual(2);
      expect(
        await countQueries(() =>
          get(`/api/v1/districts?cityId=${cityId.get('Hà Nội')}&pageSize=10&page=2`),
        ),
      ).toBe(2);
      const service = t.app.get(LocationQueryService);
      expect(
        await countQueries(() => service.isDistrictInCity(cityId.get('Hà Nội')!, randomUUID())),
      ).toBe(1);
    });
  });
});
