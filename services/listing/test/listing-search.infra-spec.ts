import { plainToInstance } from 'class-transformer';
import { randomUUID } from 'node:crypto';
import { Client } from 'pg';
import { DataSource } from 'typeorm';
import { SearchListingsQuery } from '../src/listing/dto/search-listings.query';
import { buildSearchSql } from '../src/listing/services/listing-search.sql';
import type { TestApp } from './helpers/create-test-app';
import { INFRA_TEST_SCHEMA } from './helpers/infra';
import { FixtureListing, haversineM, insertListing } from './helpers/listing-fixtures';

/**
 * Tìm kiếm `GET /api/v1/listings` (route 11) với Postgres + PostGIS THẬT (`pnpm infra:up`, rồi
 * `pnpm test:infra`). Test thiết kế 4, 18, 19 (`RE.LISTING/Component_Class_Design.md §3`, v1.4).
 *
 * Test 4 chạy trên fixture: tin tọa độ thật ở Hà Nội với khoảng cách tới Bách Khoa được tính ĐỘC LẬP
 * bằng haversine (không dùng PostGIS để tự kiểm PostGIS) + ~5.000 tin ngẫu nhiên đã `ANALYZE` để `EXPLAIN`
 * chứng minh được index GiST (với vài chục dòng planner quét tuần tự). Seed thật là T2.4.
 */
const BUCKET = 'listing-images';
const ENV_NAMES = ['S3_ENDPOINT', 'S3_REGION', 'S3_ACCESS_KEY', 'S3_SECRET_KEY', 'S3_BUCKETS'];

/** Điểm tìm: ĐH Bách Khoa Hà Nội. */
const CENTER = { lat: 21.0054, lng: 105.8431 };

interface Place {
  title: string;
  lat: number;
  lng: number;
  over: FixtureListing;
}

/** Tọa độ thật ở Hà Nội (làm tròn 4 chữ số). `createdAt` tăng dần theo thứ tự trong mảng. */
const PLACES: Place[] = [
  place('ĐH Kinh tế Quốc dân', 21.0001, 105.8469, {
    district: 'Hai Bà Trưng',
    priceVnd: 3000000,
    areaM2: 20,
    amenities: ['WIFI'],
    status: 'AVAILABLE',
  }),
  place('Vincom Bà Triệu', 21.0114, 105.8494, {
    district: 'Hai Bà Trưng',
    priceVnd: 5000000,
    areaM2: 35,
    amenities: ['WIFI', 'PARKING'],
    status: 'HELD',
  }),
  place('Công viên Thống Nhất', 21.0125, 105.8446, {
    district: 'Hai Bà Trưng',
    priceVnd: 4000000,
    areaM2: 28,
    amenities: ['PARKING'],
    status: 'DEPOSITED',
  }),
  place('Phố Huế', 21.0166, 105.8499, {
    district: 'Hai Bà Trưng',
    priceVnd: 6500000,
    areaM2: 45,
    amenities: ['WIFI', 'PARKING', 'ELEVATOR'],
    status: 'RENTED',
  }),
  place('Hồ Hoàn Kiếm', 21.0285, 105.8542, {
    district: 'Hoàn Kiếm',
    priceVnd: 8000000,
    areaM2: 50,
    amenities: ['WIFI', 'ELEVATOR'],
    status: 'AVAILABLE',
  }),
  place('Times City', 20.9955, 105.8683, {
    district: 'Hai Bà Trưng',
    priceVnd: 7000000,
    areaM2: 60,
    amenities: ['ELEVATOR', 'PARKING'],
    status: 'AVAILABLE',
  }),
  place('Ngã Tư Sở', 21.0023, 105.8197, {
    district: 'Đống Đa',
    priceVnd: 2500000,
    areaM2: 15,
    amenities: [],
    status: 'AVAILABLE',
  }),
  place('Cầu Giấy', 21.0306, 105.7973, {
    district: 'Cầu Giấy',
    priceVnd: 3500000,
    areaM2: 22,
    amenities: ['WIFI', 'FRIDGE'],
    status: 'AVAILABLE',
  }),
  place('Bến xe Giáp Bát', 20.981, 105.8412, {
    district: 'Hoàng Mai',
    priceVnd: 2000000,
    areaM2: 18,
    amenities: [],
    status: 'AVAILABLE',
  }),
];

function place(title: string, lat: number, lng: number, over: FixtureListing): Place {
  return { title, lat, lng, over };
}

const distanceTo = (p: Place): number => haversineM(CENTER, p);
const BASE_TIME = Date.parse('2026-11-20T01:00:00Z');

describe('Tìm kiếm tin đăng với hạ tầng thật', () => {
  let t: TestApp;
  let pg: Client;
  let ds: DataSource;
  const queries: string[] = [];
  const idOf = new Map<string, string>(); // title → id

  const search = (qs: string) => t.http().get(`/api/v1/listings${qs ? `?${qs}` : ''}`);
  const titles = (res: { body: { data: Array<{ title: string }> } }) =>
    res.body.data.map((i) => i.title);
  const expected = (pred: (p: Place) => boolean): string[] =>
    PLACES.filter(pred).map((p) => p.title);
  /** So sánh tập, không kể thứ tự. */
  const sameSet = (actual: string[], want: string[]) =>
    expect([...actual].sort()).toEqual([...want].sort());

  async function countQueries(call: () => Promise<unknown>): Promise<number> {
    queries.length = 0;
    await call();
    return queries.filter((q) => !/^(START TRANSACTION|COMMIT|ROLLBACK)/i.test(q)).length;
  }

  beforeAll(async () => {
    pg = new Client({ connectionString: process.env.DATABASE_URL });
    await pg.connect();
    await pg.query(`DROP SCHEMA IF EXISTS ${INFRA_TEST_SCHEMA} CASCADE`);
    await pg.query(`CREATE SCHEMA ${INFRA_TEST_SCHEMA}`);
    // Không gọi S3 trong file này (service không tạo bucket lúc khởi động, decisions/0016): giá trị giả
    Object.assign(process.env, {
      S3_ENDPOINT: 'http://s3.invalid',
      S3_REGION: 'auto',
      S3_ACCESS_KEY: 'khong-dung',
      S3_SECRET_KEY: 'khong-dung',
      S3_BUCKETS: BUCKET,
    });
    const { createTestApp } = await import('./helpers/create-test-app');
    t = await createTestApp();
    ds = t.app.get(DataSource);
    await ds.runMigrations();

    // Tin tìm thấy được: tọa độ thật
    for (const [index, p] of PLACES.entries()) {
      const id = await insertListing(pg, {
        ...p.over,
        title: p.title,
        lat: p.lat,
        lng: p.lng,
        createdAt: new Date(BASE_TIME + index * 60_000),
      });
      idOf.set(p.title, id);
    }
    // Tin KHÔNG được thấy, đặt ngay cạnh điểm tìm (cùng giá, diện tích, tiện ích như tin thường)
    const hidden: Array<[string, FixtureListing]> = [
      ['TIN ẨN', { status: 'HIDDEN' }],
      ['TIN CHỜ DUYỆT', { approvalStatus: 'PENDING_REVIEW' }],
      ['TIN BỊ TỪ CHỐI', { approvalStatus: 'REJECTED' }],
      ['TIN ĐÃ XÓA', { deletedAt: new Date() }],
    ];
    for (const [title, over] of hidden) {
      await insertListing(pg, { title, lat: 21.0058, lng: 105.8435, ...over });
    }

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

  describe('fixture hợp lệ', () => {
    it('không có tin nào nằm sát biên bán kính thử (tránh lệch spheroid/cầu làm test chập chờn)', () => {
      for (const p of PLACES) {
        for (const edge of [2000, 3500]) {
          expect(Math.abs(distanceTo(p) - edge)).toBeGreaterThan(150);
        }
      }
      // và có cả tin trong lẫn ngoài bán kính 2 km, nếu không test 4 vô nghĩa
      expect(PLACES.filter((p) => distanceTo(p) <= 2000).length).toBeGreaterThan(2);
      expect(PLACES.filter((p) => distanceTo(p) > 2000).length).toBeGreaterThan(2);
    });

    it('migration có đủ index tìm kiếm: GiST vị trí, GIN tiện ích, ngày tạo, diện tích', async () => {
      const res = await pg.query<{ indexname: string; indexdef: string }>(
        `SELECT indexname, indexdef FROM pg_indexes WHERE schemaname = $1 AND tablename = 'listings'`,
        [INFRA_TEST_SCHEMA],
      );
      const defs = new Map(res.rows.map((r) => [r.indexname, r.indexdef]));
      expect(defs.get('ix_listings_location')).toMatch(/USING gist/i);
      expect(defs.get('ix_listings_amenities')).toMatch(/USING gin \(amenities\)/i);
      expect(defs.get('ix_listings_created')).toMatch(
        /\(created_at DESC, id DESC\) WHERE \(deleted_at IS NULL\)/i,
      );
      expect(defs.get('ix_listings_area')).toMatch(/\(area_m2\)/i);
    });
  });

  describe('Test 4 (Báo cáo T05): bán kính', () => {
    it('radiusKm=2: đúng tập tin trong 2 km, sort=distance, distanceM khớp haversine ±1%', async () => {
      const res = await search(`lat=${CENTER.lat}&lng=${CENTER.lng}&radiusKm=2&sort=distance`);
      expect(res.status).toBe(200);
      const inside = expected((p) => distanceTo(p) <= 2000);
      sameSet(titles(res), inside);
      expect(res.body.meta.total).toBe(inside.length);

      const distances = res.body.data.map((i: { distanceM: number }) => i.distanceM);
      expect(distances).toEqual([...distances].sort((a: number, b: number) => a - b));
      for (const item of res.body.data as Array<{ title: string; distanceM: number }>) {
        const p = PLACES.find((x) => x.title === item.title)!;
        expect(Math.abs(item.distanceM - distanceTo(p)) / distanceTo(p)).toBeLessThan(0.01);
      }
    });

    it('radiusKm=3.5: rộng hơn, vẫn loại tin xa hơn', async () => {
      const res = await search(`lat=${CENTER.lat}&lng=${CENTER.lng}&radiusKm=3.5`);
      sameSet(
        titles(res),
        expected((p) => distanceTo(p) <= 3500),
      );
    });

    it('lat + lng không radiusKm: KHÔNG lọc bán kính, vẫn có distanceM và sort=distance', async () => {
      const res = await search(`lat=${CENTER.lat}&lng=${CENTER.lng}&sort=distance`);
      expect(res.status).toBe(200);
      sameSet(
        titles(res),
        PLACES.map((p) => p.title),
      );
      const distances = res.body.data.map((i: { distanceM: number }) => i.distanceM);
      expect(distances.every((d: unknown) => typeof d === 'number')).toBe(true);
      expect(distances).toEqual([...distances].sort((a: number, b: number) => a - b));
    });

    it('không lat/lng: response không có distanceM', async () => {
      const res = await search('');
      expect(res.body.data.every((i: object) => !('distanceM' in i))).toBe(true);
    });

    it('EXPLAIN: bán kính 2 km dùng ix_listings_location (≈5.000 tin ngẫu nhiên đã ANALYZE)', async () => {
      const owner = randomUUID();
      await pg.query(
        `INSERT INTO listings (owner_id, title, property_type, price_vnd, deposit_amount_vnd, area_m2,
                               address, city_id, district_id, location, approval_status)
         SELECT $1, 'Tin ngẫu nhiên ' || g, 'ROOM', 2000000 + (random() * 8000000)::bigint, 2000000,
                15 + random() * 50, 'x', d.city_id, d.id,
                ST_SetSRID(ST_MakePoint(105.70 + random() * 0.30, 20.90 + random() * 0.25), 4326)::geography,
                'APPROVED'
           FROM generate_series(1, 5000) g
           CROSS JOIN LATERAL (SELECT id, city_id FROM districts ORDER BY sort_order, id
                                OFFSET (g % 10) LIMIT 1) d`,
        [owner],
      );
      await pg.query('ANALYZE listings');
      try {
        // (1) đúng lệnh "Kiểm chứng" của PHASE-2.md T2.3
        const phase = await pg.query(
          `EXPLAIN (FORMAT JSON) SELECT id FROM listings
            WHERE ST_DWithin(location, ST_MakePoint(105.84, 21.00)::geography, 2000)`,
        );
        expect(JSON.stringify(phase.rows[0]['QUERY PLAN'])).toContain('ix_listings_location');

        // (2) đúng câu data mà service chạy (bán kính + sắp theo khoảng cách)
        const built = buildSearchSql(
          plainToInstance(SearchListingsQuery, {
            lat: String(CENTER.lat),
            lng: String(CENTER.lng),
            radiusKm: '2',
            sort: 'distance',
          }),
        );
        // EXPLAIN là lệnh tiện ích: không suy được kiểu `$n`, nên nhúng giá trị (toàn số ở câu này)
        const inline = built.dataSql.replace(/\$(\d+)/g, (_m, n: string) =>
          String(built.dataParams[Number(n) - 1]),
        );
        const plan = await pg.query(`EXPLAIN (FORMAT JSON) ${inline}`);
        expect(JSON.stringify(plan.rows[0]['QUERY PLAN'])).toContain('ix_listings_location');
      } finally {
        await pg.query(`DELETE FROM listings WHERE owner_id = $1`, [owner]);
        await pg.query('ANALYZE listings');
      }
    });
  });

  describe('Test 18: loại tin, bộ lọc, sắp xếp, phân trang', () => {
    it('chỉ tin APPROVED, chưa xóa, không HIDDEN; vẫn trả HELD, DEPOSITED, RENTED; công khai không cần token', async () => {
      const res = await search('');
      expect(res.status).toBe(200);
      sameSet(
        titles(res),
        PLACES.map((p) => p.title),
      );
      for (const bad of ['TIN ẨN', 'TIN CHỜ DUYỆT', 'TIN BỊ TỪ CHỐI', 'TIN ĐÃ XÓA']) {
        expect(titles(res)).not.toContain(bad);
      }
      const statuses = new Set(res.body.data.map((i: { status: string }) => i.status));
      expect(statuses).toEqual(new Set(['AVAILABLE', 'HELD', 'DEPOSITED', 'RENTED']));
    });

    it('available=true chỉ AVAILABLE; available=false không lọc thêm', async () => {
      sameSet(
        titles(await search('available=true')),
        expected((p) => p.over.status === 'AVAILABLE'),
      );
      sameSet(
        titles(await search('available=false')),
        PLACES.map((p) => p.title),
      );
    });

    it('giá và diện tích, gồm cả hai đầu', async () => {
      sameSet(
        titles(await search('minPrice=3000000&maxPrice=5000000')),
        expected((p) => p.over.priceVnd! >= 3000000 && p.over.priceVnd! <= 5000000),
      );
      sameSet(
        titles(await search('minArea=20&maxArea=35')),
        expected((p) => p.over.areaM2! >= 20 && p.over.areaM2! <= 35),
      );
    });

    it('v1.5: quận theo districtId, tỉnh theo cityId; id không có hoặc quận khác tỉnh → rỗng', async () => {
      const ids = await pg.query<{ city: string; district: string; cid: string; did: string }>(
        `SELECT c.name AS city, d.name AS district, c.id AS cid, d.id AS did
           FROM districts d JOIN cities c ON c.id = d.city_id`,
      );
      const did = (city: string, district: string) =>
        ids.rows.find((r) => r.city === city && r.district === district)!.did;
      const cid = (city: string) => ids.rows.find((r) => r.city === city)!.cid;
      const hbt = did('Hà Nội', 'Hai Bà Trưng');
      sameSet(
        titles(await search(`districtId=${hbt}`)),
        expected((p) => (p.over.district ?? 'Hai Bà Trưng') === 'Hai Bà Trưng'),
      );
      sameSet(
        titles(await search(`cityId=${cid('Hà Nội')}`)),
        expected(() => true),
      );
      sameSet(
        titles(await search(`cityId=${cid('Hà Nội')}&districtId=${hbt}`)),
        expected((p) => (p.over.district ?? 'Hai Bà Trưng') === 'Hai Bà Trưng'),
      );
      expect(titles(await search(`cityId=${cid('Hồ Chí Minh')}`))).toEqual([]);
      expect(titles(await search(`cityId=${cid('Hồ Chí Minh')}&districtId=${hbt}`))).toEqual([]);
      expect(titles(await search(`districtId=${randomUUID()}`))).toEqual([]);
      const legacy = await search(`district=${encodeURIComponent('Hai Bà Trưng')}`);
      expect(legacy.status).toBe(400);
    });

    it('v1.5: kết quả có cityId, city, districtId, district (tên từ danh mục)', async () => {
      const res = await search('pageSize=1');
      expect(res.body.data[0]).toMatchObject({ city: 'Hà Nội' });
      expect(res.body.data[0].cityId).toEqual(expect.any(String));
      expect(res.body.data[0].districtId).toEqual(expect.any(String));
      expect(res.body.data[0].district).toEqual(expect.any(String));
    });

    it('tiện ích: tin phải có MỌI mã (CSV hoặc lặp tham số)', async () => {
      const both = expected(
        (p) => p.over.amenities!.includes('WIFI') && p.over.amenities!.includes('PARKING'),
      );
      expect(both.length).toBeGreaterThan(0);
      sameSet(titles(await search('amenities=WIFI,PARKING')), both);
      sameSet(titles(await search('amenities=WIFI&amenities=PARKING')), both);
      sameSet(
        titles(await search('amenities=ELEVATOR')),
        expected((p) => p.over.amenities!.includes('ELEVATOR')),
      );
    });

    it('sắp xếp newest (mặc định), price_asc, price_desc', async () => {
      const byCreated = PLACES.map((p) => p.title).reverse();
      expect(titles(await search(''))).toEqual(byCreated);
      expect(titles(await search('sort=newest'))).toEqual(byCreated);

      const byPrice = [...PLACES].sort((a, b) => a.over.priceVnd! - b.over.priceVnd!);
      expect(titles(await search('sort=price_asc'))).toEqual(byPrice.map((p) => p.title));
      expect(titles(await search('sort=price_desc'))).toEqual(
        [...byPrice].reverse().map((p) => p.title),
      );
    });

    it('phân trang: total, totalPages, trang cuối, ngoài trang → rỗng; pageSize > 50 → 400', async () => {
      const first = await search('pageSize=4&page=1');
      expect(first.body.meta).toMatchObject({ page: 1, pageSize: 4, total: 9, totalPages: 3 });
      expect(first.body.data).toHaveLength(4);
      const last = await search('pageSize=4&page=3');
      expect(last.body.data).toHaveLength(1);
      const beyond = await search('pageSize=4&page=9');
      expect(beyond.status).toBe(200);
      expect(beyond.body.data).toEqual([]);
      expect(beyond.body.meta.total).toBe(9);

      // ba trang ghép lại = toàn bộ, không trùng, không sót (khóa phụ ổn định)
      const all = [...titles(first), ...titles(await search('pageSize=4&page=2')), ...titles(last)];
      expect(new Set(all).size).toBe(9);

      expect((await search('pageSize=51')).status).toBe(400);
    });

    it('ảnh bìa: ảnh có sort_order nhỏ nhất; chưa có ảnh → null; không lộ object key thô, description, approvalStatus', async () => {
      const id = idOf.get('ĐH Kinh tế Quốc dân')!;
      await pg.query(
        `INSERT INTO listing_images (listing_id, object_key, sort_order) VALUES ($1, $2, 1), ($1, $3, 0)`,
        [id, `listings/${id}/second.png`, `listings/${id}/cover.png`],
      );
      const res = await search('minPrice=3000000&maxPrice=3000000');
      expect(titles(res)).toEqual(['ĐH Kinh tế Quốc dân']);
      const item = res.body.data[0];
      expect(item.coverImageUrl).toContain(`listings/${id}/cover.png`);
      expect(item.coverImageUrl).not.toContain('second.png');
      for (const field of ['description', 'approvalStatus', 'rejectReason', 'images', 'coverKey']) {
        expect(item).not.toHaveProperty(field);
      }

      const none = await search('minPrice=8000000&maxPrice=8000000');
      expect(none.body.data[0].coverImageUrl).toBeNull();
    });
  });

  describe('Test 19: query sai → 400 VALIDATION_FAILED', () => {
    it.each([
      ['lat không có lng', 'lat=21'],
      ['lng không có lat', 'lng=105.8'],
      ['radiusKm thiếu lat và lng', 'radiusKm=2'],
      ['radiusKm = 0', 'lat=21&lng=105.8&radiusKm=0'],
      ['radiusKm > 50', 'lat=21&lng=105.8&radiusKm=51'],
      ['sort=distance thiếu lat và lng', 'sort=distance'],
      ['minPrice > maxPrice', 'minPrice=5000000&maxPrice=1000000'],
      ['minArea > maxArea', 'minArea=50&maxArea=10'],
      ['tiện ích lạ', 'amenities=WIFI,JACUZZI'],
      ['sort lạ', 'sort=rating'],
      ['tham số lạ', 'ownerId=x'],
    ])('%s', async (_name, qs) => {
      const res = await search(qs);
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_FAILED');
    });
  });

  describe('số truy vấn (non-functional-standards.md §1: danh sách ≤ 4)', () => {
    it('tìm kiếm có kết quả: 2 truy vấn (count + data kèm ảnh bìa); không có kết quả: 1', async () => {
      expect(await countQueries(() => search(''))).toBe(2);
      expect(
        await countQueries(() =>
          search(`lat=${CENTER.lat}&lng=${CENTER.lng}&radiusKm=2&sort=distance&amenities=WIFI`),
        ),
      ).toBe(2);
      expect(await countQueries(() => search('minPrice=999999999'))).toBe(1);
    });
  });
});
