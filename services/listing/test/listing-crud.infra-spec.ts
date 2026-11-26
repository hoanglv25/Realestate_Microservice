import { JwtService } from '@nestjs/jwt';
import { generateKeyPairSync, randomUUID } from 'node:crypto';
import { Client } from 'pg';
import { DataSource } from 'typeorm';
import { StorageService } from '../src/storage/storage.service';
import type { TestApp } from './helpers/create-test-app';
import { INFRA_TEST_SCHEMA, readRootEnv } from './helpers/infra';

/**
 * Sản phẩm, duyệt, ảnh (`RE.LISTING` route 1–10, 12) với Postgres + PostGIS + S3 (Silo) THẬT
 * (pnpm infra:up, rồi pnpm test:infra). Schema Postgres riêng (search_path có `public` để thấy kiểu
 * `geography`), khóa RSA tạo tạm, ảnh thử xóa ở cuối. Test thiết kế 1, 2, 3, 12–17
 * (`Component_Class_Design.md §3`).
 */
const { privateKey, publicKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});
const ISSUER = 'realestate-identity-test';
const BUCKET = 'listing-images';
const ENV_NAMES = [
  'S3_ENDPOINT',
  'S3_PUBLIC_ENDPOINT',
  'S3_ACCESS_KEY',
  'S3_SECRET_KEY',
  'S3_BUCKETS',
  'JWT_PUBLIC_KEY',
  'JWT_ISSUER',
];
/** PNG 1x1 hợp lệ, đủ cho `HeadObject` (service không đọc nội dung ảnh). */
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

describe('Sản phẩm, duyệt, ảnh với hạ tầng thật', () => {
  let t: TestApp;
  let pg: Client;
  let ds: DataSource;
  let storage: StorageService;
  const queries: string[] = [];
  /** `RE.LOCATION`: id theo tên, nạp sau migration. Khóa tỉnh: tên; khóa quận: `tỉnh|quận`. */
  const cityIds = new Map<string, string>();
  const districtIds = new Map<string, string>();
  const cid = (city: string) => cityIds.get(city)!;
  const did = (city: string, district: string) => districtIds.get(`${city}|${district}`)!;
  const uploadedKeys = new Set<string>();
  const jwt = new JwtService();

  const landlordA = { id: randomUUID(), token: '' };
  const landlordB = { id: randomUUID(), token: '' };
  const admin = { id: randomUUID(), token: '' };
  const tenant = { id: randomUUID(), token: '' };
  const sign = (sub: string, role: string) =>
    jwt.sign(
      { sub, roles: [role] },
      { privateKey, algorithm: 'RS256', issuer: ISSUER, expiresIn: '1h' },
    );

  const as = (token: string) => ({
    get: (path: string) => t.http().get(path).set('Authorization', `Bearer ${token}`),
    post: (path: string, body?: object) =>
      t.http().post(path).set('Authorization', `Bearer ${token}`).send(body),
    patch: (path: string, body: object) =>
      t.http().patch(path).set('Authorization', `Bearer ${token}`).send(body),
    delete: (path: string) => t.http().delete(path).set('Authorization', `Bearer ${token}`),
  });

  const valid = (over: Record<string, unknown> = {}) => ({
    title: 'Phòng 25m2 gần ĐH Bách Khoa',
    description: 'Sạch sẽ',
    propertyType: 'ROOM',
    priceVnd: 3500000,
    depositAmountVnd: 3500000,
    areaM2: 25.5,
    address: '1 Đại Cồ Việt',
    cityId: cid('Hà Nội'),
    districtId: did('Hà Nội', 'Hai Bà Trưng'),
    amenities: ['WIFI', 'FRIDGE'],
    lat: 21.0054,
    lng: 105.8431,
    ...over,
  });

  /** Tạo tin bằng API, trả `id`. `approve` = admin duyệt luôn. */
  async function newListing(
    owner = landlordA,
    over: Record<string, unknown> = {},
    approve = false,
  ) {
    const res = await as(owner.token).post('/api/v1/listings', valid(over));
    expect(res.status).toBe(201);
    const id = res.body.data.id as string;
    if (approve) {
      const ok = await as(admin.token).post(`/api/v1/admin/listings/${id}/approve`);
      expect(ok.status).toBe(200);
    }
    return id;
  }
  const row = async (id: string) =>
    (await pg.query(`SELECT * FROM listings WHERE id = $1`, [id])).rows[0];
  const imageRows = async (id: string) =>
    (await pg.query(`SELECT * FROM listing_images WHERE listing_id = $1 ORDER BY sort_order`, [id]))
      .rows;
  const publicStatus = async (id: string) => (await t.http().get(`/api/v1/listings/${id}`)).status;

  /** Số câu SQL của MỘT lời gọi (bỏ lệnh điều khiển transaction). */
  async function countQueries(call: () => Promise<unknown>): Promise<number> {
    queries.length = 0;
    await call();
    return queries.filter((q) => !/^(START TRANSACTION|COMMIT|ROLLBACK)/i.test(q)).length;
  }

  /** Lấy upload-url rồi PUT ảnh lên S3 như trình duyệt. Trả `key` (chưa xác nhận). */
  async function putImage(
    owner: { token: string },
    id: string,
    body: Buffer = PNG,
    contentType = 'image/png',
  ): Promise<string> {
    const res = await as(owner.token).post(`/api/v1/listings/${id}/images/upload-url`, {
      contentType,
    });
    expect(res.status).toBe(200);
    const { uploadUrl, key } = res.body.data as { uploadUrl: string; key: string };
    uploadedKeys.add(key);
    const put = await fetch(uploadUrl, {
      method: 'PUT',
      headers: { 'Content-Type': contentType },
      body: new Uint8Array(body),
    });
    expect(put.status).toBe(200);
    return key;
  }
  const confirm = (owner: { token: string }, id: string, key: string) =>
    as(owner.token).post(`/api/v1/listings/${id}/images`, { key });

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
      JWT_PUBLIC_KEY: publicKey,
      JWT_ISSUER: ISSUER,
    });
    const { createTestApp } = await import('./helpers/create-test-app');
    t = await createTestApp();
    ds = t.app.get(DataSource);
    storage = t.app.get(StorageService);
    await storage.bucketsReady;
    await ds.runMigrations();
    const loc = await pg.query<{ cid: string; city: string; did: string; district: string }>(
      `SELECT c.id AS cid, c.name AS city, d.id AS did, d.name AS district
         FROM districts d JOIN cities c ON c.id = d.city_id`,
    );
    for (const r of loc.rows) {
      cityIds.set(r.city, r.cid);
      districtIds.set(`${r.city}|${r.district}`, r.did);
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
    landlordA.token = sign(landlordA.id, 'LANDLORD');
    landlordB.token = sign(landlordB.id, 'LANDLORD');
    admin.token = sign(admin.id, 'ADMIN');
    tenant.token = sign(tenant.id, 'TENANT');
  });

  afterAll(async () => {
    for (const key of uploadedKeys) await storage?.deleteObject(BUCKET, key).catch(() => undefined);
    await t?.app.close();
    await pg?.query(`DROP SCHEMA IF EXISTS ${INFRA_TEST_SCHEMA} CASCADE`).catch(() => undefined);
    await pg?.end();
    for (const name of ENV_NAMES) delete process.env[name];
  });

  describe('Test 1 (Báo cáo T04): chỉ chủ tin được sửa', () => {
    it('người khác sửa, ẩn, xóa, xin URL ảnh, xác nhận ảnh → 403 LISTING_NOT_OWNER, dữ liệu không đổi', async () => {
      const id = await newListing();
      const other = as(landlordB.token);
      const responses = [
        await other.patch(`/api/v1/listings/${id}`, { title: 'Bị người khác sửa' }),
        await other.post(`/api/v1/listings/${id}/hide`),
        await other.post(`/api/v1/listings/${id}/unhide`),
        await other.delete(`/api/v1/listings/${id}`),
        await other.post(`/api/v1/listings/${id}/images/upload-url`, { contentType: 'image/png' }),
        await other.post(`/api/v1/listings/${id}/images`, {
          key: `listings/${id}/${randomUUID()}.png`,
        }),
      ];
      for (const res of responses) {
        expect(res.status).toBe(403);
        expect(res.body.error.code).toBe('LISTING_NOT_OWNER');
      }
      const after = await row(id);
      expect(after.title).toBe('Phòng 25m2 gần ĐH Bách Khoa');
      expect(after.status).toBe('AVAILABLE');
      expect(after.deleted_at).toBeNull();
    });

    it('không có tin hoặc tin đã xóa → 404 LISTING_NOT_FOUND (kiểm tồn tại trước kiểm chủ)', async () => {
      const missing = randomUUID();
      const gone = await newListing();
      expect((await as(landlordA.token).delete(`/api/v1/listings/${gone}`)).status).toBe(204);
      for (const id of [missing, gone]) {
        for (const res of [
          await as(landlordA.token).patch(`/api/v1/listings/${id}`, { title: 'Tiêu đề mới' }),
          await as(landlordA.token).post(`/api/v1/listings/${id}/hide`),
          await as(landlordA.token).delete(`/api/v1/listings/${id}`),
          await as(landlordB.token).post(`/api/v1/listings/${id}/images/upload-url`, {
            contentType: 'image/png',
          }),
          await as(admin.token).post(`/api/v1/admin/listings/${id}/approve`),
        ]) {
          expect(res.status).toBe(404);
          expect(res.body.error.code).toBe('LISTING_NOT_FOUND');
        }
      }
    });
  });

  describe('Test 2 (Báo cáo T18): không xóa tin đang có đơn đặt cọc', () => {
    it.each(['HELD', 'DEPOSITED'])(
      'tin %s → 409 LISTING_HAS_ACTIVE_DEPOSIT, không xóa',
      async (status) => {
        const id = await newListing(landlordA, {}, true);
        await pg.query(`UPDATE listings SET status = $2 WHERE id = $1`, [id, status]);
        const res = await as(landlordA.token).delete(`/api/v1/listings/${id}`);
        expect(res.status).toBe(409);
        expect(res.body.error.code).toBe('LISTING_HAS_ACTIVE_DEPOSIT');
        expect((await row(id)).deleted_at).toBeNull();
        expect(await publicStatus(id)).toBe(200);
      },
    );

    it('tin AVAILABLE → 204, từ đó 404 ở chi tiết và không còn trong "của tôi"', async () => {
      const id = await newListing(landlordA, {}, true);
      const res = await as(landlordA.token).delete(`/api/v1/listings/${id}`);
      expect(res.status).toBe(204);
      expect(res.text).toBe('');
      expect((await row(id)).deleted_at).not.toBeNull();
      expect(await publicStatus(id)).toBe(404);
      const mine = await as(landlordA.token).get('/api/v1/listings/mine?pageSize=50');
      expect((mine.body.data as Array<{ id: string }>).map((l) => l.id)).not.toContain(id);
    });

    it('hide không đè lên tin đang HELD (cùng điều kiện status = AVAILABLE với giữ chỗ)', async () => {
      const id = await newListing();
      await pg.query(`UPDATE listings SET status = 'HELD' WHERE id = $1`, [id]);
      const res = await as(landlordA.token).post(`/api/v1/listings/${id}/hide`);
      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe('LISTING_INVALID_STATUS');
      expect((await row(id)).status).toBe('HELD');
    });
  });

  describe('Test 3: tạo tin, duyệt, duyệt lại', () => {
    it('tạo tin → 201 PENDING_REVIEW + AVAILABLE; chủ là sub của JWT; chưa hiện ở chi tiết công khai', async () => {
      const res = await as(landlordA.token).post('/api/v1/listings', valid());
      expect(res.status).toBe(201);
      const dto = res.body.data;
      expect(dto).toMatchObject({
        ownerId: landlordA.id,
        approvalStatus: 'PENDING_REVIEW',
        status: 'AVAILABLE',
        priceVnd: 3500000,
        depositAmountVnd: 3500000,
        areaM2: 25.5,
        amenities: ['WIFI', 'FRIDGE'],
        rejectReason: null,
        images: [],
      });
      expect(dto.lat).toBeCloseTo(21.0054, 6);
      expect(dto.lng).toBeCloseTo(105.8431, 6);
      expect(dto).not.toHaveProperty('version');
      expect(dto).not.toHaveProperty('cityName');
      expect(dto).not.toHaveProperty('heldUntil');
      expect(await publicStatus(dto.id)).toBe(404);
      // PostGIS lưu (lng, lat): kiểm thẳng trong DB
      const geo = await pg.query(
        `SELECT ST_X(location::geometry) AS lng, ST_Y(location::geometry) AS lat FROM listings WHERE id = $1`,
        [dto.id],
      );
      expect(geo.rows[0].lng).toBeCloseTo(105.8431, 6);
      expect(geo.rows[0].lat).toBeCloseTo(21.0054, 6);
    });

    it('client không đặt được ownerId, status, approvalStatus (trường thừa → 400)', async () => {
      for (const over of [
        { ownerId: landlordB.id },
        { status: 'HELD' },
        { approvalStatus: 'APPROVED' },
      ]) {
        const res = await as(landlordA.token).post('/api/v1/listings', valid(over));
        expect(res.status).toBe(400);
        expect(res.body.error.code).toBe('VALIDATION_FAILED');
      }
    });

    it('quản trị viên duyệt → APPROVED, hiện ở chi tiết công khai (không cần token); duyệt lại → 409', async () => {
      const id = await newListing();
      const ok = await as(admin.token).post(`/api/v1/admin/listings/${id}/approve`);
      expect(ok.status).toBe(200);
      expect(ok.body.data.approvalStatus).toBe('APPROVED');
      const db = await row(id);
      expect(db.reviewed_by).toBe(admin.id);
      expect(db.reviewed_at).not.toBeNull();

      const detail = await t.http().get(`/api/v1/listings/${id}`);
      expect(detail.status).toBe(200);
      expect(detail.body.data.id).toBe(id);

      for (const res of [
        await as(admin.token).post(`/api/v1/admin/listings/${id}/approve`),
        await as(admin.token).post(`/api/v1/admin/listings/${id}/reject`, { reason: 'Muộn' }),
      ]) {
        expect(res.status).toBe(409);
        expect(res.body.error.code).toBe('LISTING_ALREADY_REVIEWED');
      }
    });

    it('từ chối kèm lý do → REJECTED, lưu lý do; không hiện công khai; thiếu lý do → 400', async () => {
      const id = await newListing();
      const bad = await as(admin.token).post(`/api/v1/admin/listings/${id}/reject`, {});
      expect(bad.status).toBe(400);
      const ok = await as(admin.token).post(`/api/v1/admin/listings/${id}/reject`, {
        reason: 'Ảnh không đúng với căn phòng',
      });
      expect(ok.status).toBe(200);
      expect(ok.body.data).toMatchObject({
        approvalStatus: 'REJECTED',
        rejectReason: 'Ảnh không đúng với căn phòng',
      });
      expect(await publicStatus(id)).toBe(404);
    });

    it('hai quản trị viên duyệt cùng lúc: đúng một người thắng', async () => {
      const id = await newListing();
      const results = await Promise.all(
        Array.from({ length: 5 }, () =>
          as(admin.token).post(`/api/v1/admin/listings/${id}/approve`),
        ),
      );
      expect(results.filter((r) => r.status === 200)).toHaveLength(1);
      expect(results.filter((r) => r.status === 409)).toHaveLength(4);
    });

    it('sửa tin APPROVED: nội dung hiển thị → PENDING_REVIEW và hết công khai; giá/cọc/diện tích/tiện ích → giữ APPROVED', async () => {
      const id = await newListing(landlordA, {}, true);
      for (const patch of [
        { priceVnd: 4000000 },
        { depositAmountVnd: 5000000 },
        { areaM2: 30 },
        { amenities: ['WIFI', 'PARKING'] },
        { title: 'Phòng 25m2 gần ĐH Bách Khoa' }, // gửi lại đúng giá trị cũ
      ]) {
        const res = await as(landlordA.token).patch(`/api/v1/listings/${id}`, patch);
        expect(res.status).toBe(200);
        expect(res.body.data.approvalStatus).toBe('APPROVED');
      }
      expect(await publicStatus(id)).toBe(200);
      expect((await row(id)).reviewed_by).toBe(admin.id);

      const res = await as(landlordA.token).patch(`/api/v1/listings/${id}`, {
        title: 'Phòng mới sửa tiêu đề',
      });
      expect(res.status).toBe(200);
      expect(res.body.data).toMatchObject({
        title: 'Phòng mới sửa tiêu đề',
        approvalStatus: 'PENDING_REVIEW',
      });
      const db = await row(id);
      expect(db.reviewed_by).toBeNull();
      expect(db.reviewed_at).toBeNull();
      expect(await publicStatus(id)).toBe(404);
    });

    it.each([
      ['description', { description: 'Mô tả khác' }],
      ['propertyType', { propertyType: 'HOUSE' }],
      ['address', { address: '2 Tạ Quang Bửu' }],
      ['vị trí lat/lng', { lat: 21.02, lng: 105.85 }],
    ])('sửa tin APPROVED: %s → PENDING_REVIEW', async (_name, patch) => {
      const id = await newListing(landlordA, {}, true);
      const res = await as(landlordA.token).patch(`/api/v1/listings/${id}`, patch);
      expect(res.status).toBe(200);
      expect(res.body.data.approvalStatus).toBe('PENDING_REVIEW');
    });

    it('đổi vị trí thật sự ghi vào PostGIS (lat/lng trả về khớp)', async () => {
      const id = await newListing(landlordA, {}, true);
      const res = await as(landlordA.token).patch(`/api/v1/listings/${id}`, {
        lat: 10.7769,
        lng: 106.7009,
      });
      expect(res.body.data.lat).toBeCloseTo(10.7769, 6);
      expect(res.body.data.lng).toBeCloseTo(106.7009, 6);
    });

    it('Test 14: sửa tin REJECTED, bất kỳ trường nào (kể cả giá) → PENDING_REVIEW, xóa lý do', async () => {
      const id = await newListing();
      await as(admin.token).post(`/api/v1/admin/listings/${id}/reject`, { reason: 'Thiếu ảnh' });
      const res = await as(landlordA.token).patch(`/api/v1/listings/${id}`, { priceVnd: 3000000 });
      expect(res.status).toBe(200);
      expect(res.body.data).toMatchObject({
        approvalStatus: 'PENDING_REVIEW',
        rejectReason: null,
        priceVnd: 3000000,
      });
      // nộp lại rồi duyệt được
      const ok = await as(admin.token).post(`/api/v1/admin/listings/${id}/approve`);
      expect(ok.status).toBe(200);
    });

    it('sửa tin chưa duyệt (PENDING_REVIEW) giữ nguyên PENDING_REVIEW; body rỗng → 400; chỉ gửi lat → 400', async () => {
      const id = await newListing();
      const ok = await as(landlordA.token).patch(`/api/v1/listings/${id}`, {
        title: 'Tiêu đề đã sửa',
      });
      expect(ok.body.data.approvalStatus).toBe('PENDING_REVIEW');
      const empty = await as(landlordA.token).patch(`/api/v1/listings/${id}`, {});
      expect(empty.status).toBe(400);
      expect(empty.body.error.code).toBe('VALIDATION_FAILED');
      const half = await as(landlordA.token).patch(`/api/v1/listings/${id}`, { lat: 21 });
      expect(half.status).toBe(400);
    });

    it('ẩn rồi hiện lại: AVAILABLE ↔ HIDDEN; ẩn hai lần hoặc hiện tin chưa ẩn → 409 LISTING_INVALID_STATUS', async () => {
      const id = await newListing();
      const owner = as(landlordA.token);
      expect((await owner.post(`/api/v1/listings/${id}/unhide`)).body.error.code).toBe(
        'LISTING_INVALID_STATUS',
      );
      const hidden = await owner.post(`/api/v1/listings/${id}/hide`);
      expect(hidden.status).toBe(200);
      expect(hidden.body.data.status).toBe('HIDDEN');
      expect((await owner.post(`/api/v1/listings/${id}/hide`)).status).toBe(409);
      const shown = await owner.post(`/api/v1/listings/${id}/unhide`);
      expect(shown.body.data.status).toBe('AVAILABLE');
    });

    it('chi tiết công khai vẫn trả tin HIDDEN (chỉ tìm kiếm loại tin ẩn)', async () => {
      const id = await newListing(landlordA, {}, true);
      await as(landlordA.token).post(`/api/v1/listings/${id}/hide`);
      const res = await t.http().get(`/api/v1/listings/${id}`);
      expect(res.status).toBe(200);
      expect(res.body.data.status).toBe('HIDDEN');
    });

    it('"của tôi": chỉ tin của mình, mọi trạng thái duyệt, mới nhất trước, phân trang', async () => {
      const owner = { id: randomUUID(), token: '' };
      owner.token = sign(owner.id, 'LANDLORD');
      const ids: string[] = [];
      for (let i = 0; i < 3; i++)
        ids.push(await newListing(owner, { title: `Tin số ${i + 1} của tôi` }));
      await newListing(landlordB, { title: 'Tin của người khác' });
      await as(admin.token).post(`/api/v1/admin/listings/${ids[0]}/approve`);
      await as(admin.token).post(`/api/v1/admin/listings/${ids[1]}/reject`, { reason: 'x' });

      const page1 = await as(owner.token).get('/api/v1/listings/mine?page=1&pageSize=2');
      expect(page1.status).toBe(200);
      expect(page1.body.meta).toMatchObject({ page: 1, pageSize: 2, total: 3, totalPages: 2 });
      expect((page1.body.data as Array<{ id: string }>).map((l) => l.id)).toEqual([ids[2], ids[1]]);
      const page2 = await as(owner.token).get('/api/v1/listings/mine?page=2&pageSize=2');
      expect((page2.body.data as Array<{ id: string }>).map((l) => l.id)).toEqual([ids[0]]);
      const states = (page1.body.data as Array<{ approvalStatus: string }>).map(
        (l) => l.approvalStatus,
      );
      expect(states).toEqual(['PENDING_REVIEW', 'REJECTED']);
    });

    it('vai trò: TENANT không thêm được (403 FORBIDDEN_ROLE); LANDLORD không duyệt được; thiếu token → 401; "mine" không bị coi là id', async () => {
      const a = await as(tenant.token).post('/api/v1/listings', valid());
      expect([a.status, a.body.error.code]).toEqual([403, 'FORBIDDEN_ROLE']);
      const b = await as(landlordA.token).post(`/api/v1/admin/listings/${randomUUID()}/approve`);
      expect([b.status, b.body.error.code]).toEqual([403, 'FORBIDDEN_ROLE']);
      expect((await t.http().post('/api/v1/listings').send(valid())).status).toBe(401);
      expect((await t.http().get('/api/v1/listings/mine')).status).toBe(401);
      const bad = await t.http().get('/api/v1/listings/khong-phai-uuid');
      expect([bad.status, bad.body.error.code, bad.body.error.message]).toEqual([
        400,
        'VALIDATION_FAILED',
        'id phải là UUID',
      ]);
    });
  });

  describe('Test 12 (và 13, 16, 17): ảnh', () => {
    it('luồng đầy đủ: upload-url → PUT lên S3 → xác nhận 201 → chi tiết có URL xem được', async () => {
      const id = await newListing(landlordA, {}, true);
      const key = await putImage(landlordA, id);
      expect(key).toMatch(new RegExp(`^listings/${id}/[0-9a-f-]{36}\\.png$`));
      const res = await confirm(landlordA, id, key);
      expect(res.status).toBe(201);
      expect(res.body.data).toMatchObject({ sortOrder: 0 });
      expect((await imageRows(id)).map((r) => r.object_key)).toEqual([key]);

      const detail = await as(landlordA.token).get('/api/v1/listings/mine');
      const mine = (detail.body.data as Array<{ id: string; images: Array<{ url: string }> }>).find(
        (l) => l.id === id,
      );
      expect(mine?.images).toHaveLength(1);
      const fetched = await fetch(mine!.images[0].url);
      expect(fetched.status).toBe(200);
      expect(Buffer.from(await fetched.arrayBuffer())).toEqual(PNG);
    });

    it('thêm ảnh vào tin APPROVED hoặc REJECTED → PENDING_REVIEW; tin PENDING_REVIEW giữ nguyên', async () => {
      const approved = await newListing(landlordA, {}, true);
      expect((await confirm(landlordA, approved, await putImage(landlordA, approved))).status).toBe(
        201,
      );
      expect((await row(approved)).approval_status).toBe('PENDING_REVIEW');
      expect((await row(approved)).reviewed_by).toBeNull();
      expect(await publicStatus(approved)).toBe(404);

      const rejected = await newListing();
      await as(admin.token).post(`/api/v1/admin/listings/${rejected}/reject`, {
        reason: 'Thiếu ảnh',
      });
      expect((await confirm(landlordA, rejected, await putImage(landlordA, rejected))).status).toBe(
        201,
      );
      const db = await row(rejected);
      expect(db.approval_status).toBe('PENDING_REVIEW');
      expect(db.reject_reason).toBeNull();

      const pending = await newListing();
      await confirm(landlordA, pending, await putImage(landlordA, pending));
      expect((await row(pending)).approval_status).toBe('PENDING_REVIEW');
    });

    it('ảnh vượt kích thước → 400 LISTING_IMAGE_INVALID, key không lưu, object bị xóa khỏi S3', async () => {
      const id = await newListing();
      const key = await putImage(landlordA, id, Buffer.alloc(5 * 1024 * 1024 + 1, 7));
      expect(await storage.headObject(BUCKET, key)).not.toBeNull();
      const res = await confirm(landlordA, id, key);
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('LISTING_IMAGE_INVALID');
      expect(res.body.error.details).toEqual({ reason: 'TOO_LARGE' });
      expect(await imageRows(id)).toHaveLength(0);
      expect(await storage.headObject(BUCKET, key)).toBeNull();
    });

    it('đúng 5 MB vẫn nhận', async () => {
      const id = await newListing();
      const key = await putImage(landlordA, id, Buffer.alloc(5 * 1024 * 1024, 7));
      expect((await confirm(landlordA, id, key)).status).toBe(201);
    });

    it('Test 17: xóa object lỗi vẫn trả 400 LISTING_IMAGE_INVALID và ghi log warn', async () => {
      const id = await newListing();
      const key = await putImage(landlordA, id, Buffer.alloc(5 * 1024 * 1024 + 1, 7));
      const spy = jest.spyOn(storage, 'deleteObject').mockRejectedValueOnce(new Error('S3 chết'));
      const res = await confirm(landlordA, id, key);
      spy.mockRestore();
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('LISTING_IMAGE_INVALID');
      expect(await imageRows(id)).toHaveLength(0);
      const warn = t.logRecords().find((l) => l.level === 'warn' && l.key === key);
      expect(warn).toBeDefined();
    });

    it('key chưa tải lên (không có object) → 400, không lưu', async () => {
      const id = await newListing();
      const res = await confirm(landlordA, id, `listings/${id}/${randomUUID()}.png`);
      expect(res.status).toBe(400);
      expect(res.body.error.details).toEqual({ reason: 'NOT_FOUND' });
      expect(await imageRows(id)).toHaveLength(0);
    });

    it('key do client tự nghĩ ra hoặc của tin khác → 400, không gọi S3 xác nhận bừa', async () => {
      const id = await newListing();
      const other = await newListing(landlordB);
      const otherKey = await putImage(landlordB, other);
      for (const key of [
        otherKey,
        `listings/${id}/../${randomUUID()}.png`,
        `listings/${id}/anh-cua-toi.png`,
        'bat-ky-thu-gi',
      ]) {
        const res = await confirm(landlordA, id, key);
        expect(res.status).toBe(400);
        expect(res.body.error.details).toEqual({ reason: 'KEY_NOT_OF_LISTING' });
      }
      expect(await imageRows(id)).toHaveLength(0);
      expect(await storage.headObject(BUCKET, otherKey)).not.toBeNull(); // không xóa nhầm ảnh người khác
    });

    it('loại file ngoài danh sách → 400 ở upload-url; PUT sai Content-Type bị S3 từ chối', async () => {
      const id = await newListing();
      const res = await as(landlordA.token).post(`/api/v1/listings/${id}/images/upload-url`, {
        contentType: 'text/html',
      });
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('LISTING_IMAGE_INVALID');

      const ok = await as(landlordA.token).post(`/api/v1/listings/${id}/images/upload-url`, {
        contentType: 'image/png',
      });
      const put = await fetch(ok.body.data.uploadUrl, {
        method: 'PUT',
        headers: { 'Content-Type': 'text/html' },
        body: '<script>',
      });
      expect(put.status).toBe(403);
    });

    it('Test 13: xác nhận lại cùng key → 200 kèm ảnh đã có, không thêm dòng, không đổi duyệt', async () => {
      const id = await newListing();
      const key = await putImage(landlordA, id);
      const first = await confirm(landlordA, id, key);
      expect(first.status).toBe(201);
      await as(admin.token).post(`/api/v1/admin/listings/${id}/approve`);
      const again = await confirm(landlordA, id, key);
      expect(again.status).toBe(200);
      expect(again.body.data.id).toBe(first.body.data.id);
      expect(await imageRows(id)).toHaveLength(1);
      expect((await row(id)).approval_status).toBe('APPROVED');
    });

    it('ảnh thứ 11 → 409 LISTING_IMAGE_LIMIT_REACHED ở cả upload-url lẫn xác nhận; gọi lại key cũ khi đã đủ vẫn 200', async () => {
      const id = await newListing();
      const keys: string[] = [];
      for (let i = 0; i < 10; i++) {
        const key = await putImage(landlordA, id);
        keys.push(key);
        expect((await confirm(landlordA, id, key)).status).toBe(201);
      }
      expect((await imageRows(id)).map((r) => r.sort_order)).toEqual([
        0, 1, 2, 3, 4, 5, 6, 7, 8, 9,
      ]);
      const full = await as(landlordA.token).post(`/api/v1/listings/${id}/images/upload-url`, {
        contentType: 'image/png',
      });
      expect([full.status, full.body.error.code]).toEqual([409, 'LISTING_IMAGE_LIMIT_REACHED']);
      expect((await confirm(landlordA, id, keys[3])).status).toBe(200);
      expect(await imageRows(id)).toHaveLength(10);
    });

    it('Test 16: nhiều xác nhận đồng thời khi còn một chỗ → đúng một 201, tin không vượt 10 ảnh', async () => {
      const id = await newListing();
      for (let i = 0; i < 9; i++) await confirm(landlordA, id, await putImage(landlordA, id));
      const keys = [];
      for (let i = 0; i < 5; i++) keys.push(await putImage(landlordA, id));
      const results = await Promise.all(keys.map((key) => confirm(landlordA, id, key)));
      expect(results.filter((r) => r.status === 201)).toHaveLength(1);
      expect(results.filter((r) => r.status === 409)).toHaveLength(4);
      expect(await imageRows(id)).toHaveLength(10);
      expect((await imageRows(id)).map((r) => r.sort_order)).toEqual([
        0, 1, 2, 3, 4, 5, 6, 7, 8, 9,
      ]);
    });

    it('xác nhận cùng một key đồng thời → mọi lời gọi thành công (201 hoặc 200), chỉ một dòng', async () => {
      const id = await newListing();
      const key = await putImage(landlordA, id);
      const results = await Promise.all(
        Array.from({ length: 4 }, () => confirm(landlordA, id, key)),
      );
      expect(results.every((r) => r.status === 201 || r.status === 200)).toBe(true);
      expect(results.filter((r) => r.status === 201)).toHaveLength(1);
      expect(await imageRows(id)).toHaveLength(1);
    });
  });

  describe('Số truy vấn mỗi route (non-functional-standards.md §1: ghi ≤ 6, danh sách ≤ 4, chi tiết ≤ 3)', () => {
    it('đo từng route', async () => {
      const owner = as(landlordA.token);
      const counts: Record<string, number> = {};
      let id = '';
      counts.create = await countQueries(async () => {
        id = (await owner.post('/api/v1/listings', valid())).body.data.id;
      });
      counts.updateContent = await countQueries(() =>
        owner.patch(`/api/v1/listings/${id}`, { title: 'Tiêu đề khác hẳn' }),
      );
      counts.updateNoChange = await countQueries(() =>
        owner.patch(`/api/v1/listings/${id}`, { title: 'Tiêu đề khác hẳn' }),
      );
      counts.updateLocation = await countQueries(() =>
        owner.patch(`/api/v1/listings/${id}`, {
          cityId: cid('Hà Nội'),
          districtId: did('Hà Nội', 'Cầu Giấy'),
        }),
      );
      counts.approve = await countQueries(() =>
        as(admin.token).post(`/api/v1/admin/listings/${id}/approve`),
      );
      counts.rejectAlreadyReviewed = await countQueries(() =>
        as(admin.token).post(`/api/v1/admin/listings/${id}/reject`, { reason: 'x' }),
      );
      counts.hide = await countQueries(() => owner.post(`/api/v1/listings/${id}/hide`));
      counts.hideInvalidStatus = await countQueries(() =>
        owner.post(`/api/v1/listings/${id}/hide`),
      );
      counts.unhide = await countQueries(() => owner.post(`/api/v1/listings/${id}/unhide`));
      counts.detail = await countQueries(() => t.http().get(`/api/v1/listings/${id}`));
      counts.mine = await countQueries(() => owner.get('/api/v1/listings/mine'));
      counts.uploadUrl = await countQueries(() =>
        owner.post(`/api/v1/listings/${id}/images/upload-url`, { contentType: 'image/png' }),
      );
      const key = await putImage(landlordA, id);
      counts.confirmPending = await countQueries(() => confirm(landlordA, id, key));
      counts.confirmAgain = await countQueries(() => confirm(landlordA, id, key));
      await as(admin.token).post(`/api/v1/admin/listings/${id}/approve`);
      const key2 = await putImage(landlordA, id);
      counts.confirmResubmit = await countQueries(() => confirm(landlordA, id, key2));
      counts.delete = await countQueries(() => owner.delete(`/api/v1/listings/${id}`));
      counts.deleteAgain = await countQueries(() => owner.delete(`/api/v1/listings/${id}`));
      console.info('Số truy vấn mỗi route', JSON.stringify(counts));

      const writeCeiling = 6;
      for (const name of [
        'create',
        'updateContent',
        'updateNoChange',
        'updateLocation',
        'approve',
        'rejectAlreadyReviewed',
        'hide',
        'hideInvalidStatus',
        'unhide',
        'uploadUrl',
        'confirmPending',
        'confirmAgain',
        'confirmResubmit',
        'delete',
        'deleteAgain',
      ]) {
        expect(counts[name]).toBeLessThanOrEqual(writeCeiling);
      }
      expect(counts.detail).toBeLessThanOrEqual(3);
      expect(counts.mine).toBeLessThanOrEqual(4);
      // Test 26 (v1.5, RE.LISTING/Processing_Flow.md §5): kiểm cặp tỉnh/quận cộng 1, tên lấy trong cùng câu
      expect(counts.create).toBeLessThanOrEqual(4);
      expect(counts.updateLocation).toBeLessThanOrEqual(4);
      expect(counts.updateContent).toBeLessThanOrEqual(3);
    });
  });

  describe('v1.5: tỉnh/thành, quận/huyện theo id (RE.LISTING test 22–24)', () => {
    it('Test 22: tạo tin với cặp đúng → 201, trả id và tên; DB lưu id', async () => {
      const res = await as(landlordA.token).post('/api/v1/listings', valid());
      expect(res.status).toBe(201);
      expect(res.body.data).toMatchObject({
        cityId: cid('Hà Nội'),
        city: 'Hà Nội',
        districtId: did('Hà Nội', 'Hai Bà Trưng'),
        district: 'Hai Bà Trưng',
      });
      const db = await row(res.body.data.id);
      expect(db.city_id).toBe(cid('Hà Nội'));
      expect(db.district_id).toBe(did('Hà Nội', 'Hai Bà Trưng'));
      expect(db).not.toHaveProperty('city');
      expect(db).not.toHaveProperty('district');
      // chi tiết công khai, của tôi, tìm kiếm cũng có tên (sau khi duyệt)
      await as(admin.token).post(`/api/v1/admin/listings/${res.body.data.id}/approve`);
      const detail = await t.http().get(`/api/v1/listings/${res.body.data.id}`);
      expect(detail.body.data).toMatchObject({ city: 'Hà Nội', district: 'Hai Bà Trưng' });
    });

    it('Test 23: tạo với quận của tỉnh khác hoặc id không có → 400 VALIDATION_FAILED (districtId), không tạo', async () => {
      const before = await pg.query(`SELECT count(*)::int AS n FROM listings`);
      for (const over of [
        { cityId: cid('Hồ Chí Minh'), districtId: did('Hà Nội', 'Ba Đình') },
        { districtId: randomUUID() },
        { cityId: randomUUID() },
      ]) {
        const res = await as(landlordA.token).post('/api/v1/listings', valid(over));
        expect(res.status).toBe(400);
        expect(res.body.error.code).toBe('VALIDATION_FAILED');
        expect(res.body.error.details).toEqual([
          { field: 'districtId', errors: ['Quận/huyện không thuộc tỉnh/thành đã chọn'] },
        ]);
      }
      const after = await pg.query(`SELECT count(*)::int AS n FROM listings`);
      expect(after.rows[0].n).toBe(before.rows[0].n);
    });

    it('Test 23: gửi city/district chuỗi (hợp đồng cũ), thiếu cityId → 400', async () => {
      const legacy: Record<string, unknown> = {
        ...valid(),
        city: 'Hà Nội',
        district: 'Hai Bà Trưng',
      };
      delete legacy.cityId;
      delete legacy.districtId;
      const res = await as(landlordA.token).post('/api/v1/listings', legacy);
      expect(res.status).toBe(400);
      const fields = (res.body.error.details as Array<{ field: string }>).map((d) => d.field);
      expect(fields).toEqual(expect.arrayContaining(['city', 'district', 'cityId', 'districtId']));
    });

    it('Test 23: sửa với cặp sai hoặc chỉ một trường → 400, tin không đổi', async () => {
      const id = await newListing();
      const owner = as(landlordA.token);
      const wrong = await owner.patch(`/api/v1/listings/${id}`, {
        cityId: cid('Đà Nẵng'),
        districtId: did('Hà Nội', 'Cầu Giấy'),
        title: 'Không được ghi',
      });
      expect(wrong.status).toBe(400);
      expect(wrong.body.error.details).toEqual([
        { field: 'districtId', errors: ['Quận/huyện không thuộc tỉnh/thành đã chọn'] },
      ]);
      const half = await owner.patch(`/api/v1/listings/${id}`, { cityId: cid('Đà Nẵng') });
      expect(half.status).toBe(400);
      const db = await row(id);
      expect(db.title).toBe('Phòng 25m2 gần ĐH Bách Khoa');
      expect(db.district_id).toBe(did('Hà Nội', 'Hai Bà Trưng'));
    });

    it('Test 23: cặp sai do người khác gửi → 403 trước 400 (thứ tự §1.2: 404 → 403 → 2a)', async () => {
      const id = await newListing();
      const res = await as(landlordB.token).patch(`/api/v1/listings/${id}`, {
        cityId: cid('Đà Nẵng'),
        districtId: did('Hà Nội', 'Cầu Giấy'),
      });
      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe('LISTING_NOT_OWNER');
    });

    it('Test 24: sửa tỉnh/quận của tin APPROVED → PENDING_REVIEW, response có tên mới', async () => {
      const id = await newListing(landlordA, {}, true);
      const res = await as(landlordA.token).patch(`/api/v1/listings/${id}`, {
        cityId: cid('Hồ Chí Minh'),
        districtId: did('Hồ Chí Minh', 'Quận 1'),
      });
      expect(res.status).toBe(200);
      expect(res.body.data).toMatchObject({
        approvalStatus: 'PENDING_REVIEW',
        cityId: cid('Hồ Chí Minh'),
        city: 'Hồ Chí Minh',
        districtId: did('Hồ Chí Minh', 'Quận 1'),
        district: 'Quận 1',
      });
    });

    it('Test 24: chỉ đổi quận trong cùng tỉnh của tin APPROVED → PENDING_REVIEW', async () => {
      const id = await newListing(landlordA, {}, true);
      const res = await as(landlordA.token).patch(`/api/v1/listings/${id}`, {
        cityId: cid('Hà Nội'),
        districtId: did('Hà Nội', 'Cầu Giấy'),
      });
      expect(res.body.data).toMatchObject({
        approvalStatus: 'PENDING_REVIEW',
        district: 'Cầu Giấy',
      });
    });

    it('gửi lại đúng cặp cũ cho tin APPROVED → giữ APPROVED', async () => {
      const id = await newListing(landlordA, {}, true);
      const res = await as(landlordA.token).patch(`/api/v1/listings/${id}`, {
        cityId: cid('Hà Nội'),
        districtId: did('Hà Nội', 'Hai Bà Trưng'),
      });
      expect(res.status).toBe(200);
      expect(res.body.data.approvalStatus).toBe('APPROVED');
    });
  });
});
