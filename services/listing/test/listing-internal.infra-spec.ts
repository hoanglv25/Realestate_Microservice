import { randomUUID } from 'node:crypto';
import { Client } from 'pg';
import { DataSource } from 'typeorm';
import { expectResponseMatchesOpenApi } from './helpers/contracts';
import type { TestApp } from './helpers/create-test-app';
import { INFRA_TEST_SCHEMA } from './helpers/infra';
import { FixtureListing, insertListing } from './helpers/listing-fixtures';

/**
 * API nội bộ `/internal/listings/*` (bản chụp, giữ chỗ, đổi trạng thái) với Postgres THẬT
 * (`pnpm infra:up`, rồi `pnpm test:infra`). Test thiết kế 5–11, 20, 21 (`RE.LISTING/Component_Class_Design.md §3`).
 * Mọi response phải khớp `contracts/openapi/listing-internal.v1.yaml` (DoD của T2.3).
 */
const BUCKET = 'listing-images';
const SPEC = 'listing-internal.v1.yaml';
const SNAPSHOT_PATH = '/internal/listings/{id}';
const HOLD_PATH = '/internal/listings/{id}/holds';
const STATUS_PATH = '/internal/listings/{id}/status';
const ENV_NAMES = ['S3_ENDPOINT', 'S3_REGION', 'S3_ACCESS_KEY', 'S3_SECRET_KEY', 'S3_BUCKETS'];

const inMinutes = (m: number): Date => new Date(Date.now() + m * 60_000);

describe('API nội bộ giữ chỗ, đổi trạng thái với hạ tầng thật', () => {
  let t: TestApp;
  let pg: Client;
  let ds: DataSource;
  const queries: string[] = [];

  const snapshot = (id: string) => t.http().get(`/internal/listings/${id}`);
  const hold = (id: string, depositId: string, heldUntil: Date = inMinutes(10)) =>
    t
      .http()
      .post(`/internal/listings/${id}/holds`)
      .send({ depositId, heldUntil: heldUntil.toISOString() });
  const changeStatus = (id: string, depositId: string, status: string) =>
    t.http().put(`/internal/listings/${id}/status`).send({ depositId, status });
  const row = async (id: string) =>
    (await pg.query(`SELECT * FROM listings WHERE id = $1`, [id])).rows[0];
  const matches = (path: string, method: 'GET' | 'POST' | 'PUT', status: number, body: unknown) =>
    expect(() => expectResponseMatchesOpenApi(SPEC, method, path, status, body)).not.toThrow();

  /** Tin đang được đơn `depositId` giữ (`HELD`, còn hạn 10 phút), hoặc trạng thái khác. */
  const held = (depositId: string, over: FixtureListing = {}) =>
    insertListing(pg, {
      status: 'HELD',
      heldByDepositId: depositId,
      heldUntil: inMinutes(10),
      ...over,
    });

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

  describe('Test 20: bản chụp (GET /internal/listings/:id)', () => {
    it('trả đúng 6 trường, khớp hợp đồng, kèm X-Request-ID', async () => {
      const ownerId = randomUUID();
      const id = await insertListing(pg, {
        ownerId,
        title: 'Phòng 25m2',
        depositAmountVnd: 3000000,
      });
      const res = await snapshot(id);
      expect(res.status).toBe(200);
      expect(res.body.data).toEqual({
        id,
        ownerId,
        title: 'Phòng 25m2',
        depositAmountVnd: 3000000,
        status: 'AVAILABLE',
        approvalStatus: 'APPROVED',
      });
      expect(res.headers['x-request-id']).toBeDefined();
      matches(SNAPSHOT_PATH, 'GET', 200, res.body);
    });

    it('trả cả tin HIDDEN, chưa duyệt, bị từ chối, đang HELD (rental tự xử lý)', async () => {
      const cases: Array<[FixtureListing, string, string]> = [
        [{ status: 'HIDDEN' }, 'HIDDEN', 'APPROVED'],
        [{ approvalStatus: 'PENDING_REVIEW' }, 'AVAILABLE', 'PENDING_REVIEW'],
        [{ approvalStatus: 'REJECTED' }, 'AVAILABLE', 'REJECTED'],
        [
          { status: 'HELD', heldByDepositId: randomUUID(), heldUntil: inMinutes(5) },
          'HELD',
          'APPROVED',
        ],
      ];
      for (const [over, status, approvalStatus] of cases) {
        const res = await snapshot(await insertListing(pg, over));
        expect(res.status).toBe(200);
        expect(res.body.data).toMatchObject({ status, approvalStatus });
        matches(SNAPSHOT_PATH, 'GET', 200, res.body);
      }
    });

    it('không có hoặc đã xóa mềm → 404 LISTING_NOT_FOUND, khớp hợp đồng', async () => {
      const deleted = await insertListing(pg, { deletedAt: new Date() });
      for (const id of [deleted, randomUUID()]) {
        const res = await snapshot(id);
        expect(res.status).toBe(404);
        expect(res.body.error.code).toBe('LISTING_NOT_FOUND');
        matches(SNAPSHOT_PATH, 'GET', 404, res.body);
      }
    });

    it.each(['khong-phai-uuid', '123'])(
      'id "%s" không phải UUID → 400, không truy vấn DB',
      async (bad) => {
        queries.length = 0;
        const res = await snapshot(bad);
        expect(res.status).toBe(400);
        expect(res.body.error).toMatchObject({
          code: 'VALIDATION_FAILED',
          message: 'id phải là UUID',
        });
        matches(SNAPSHOT_PATH, 'GET', 400, res.body);
        expect(queries).toHaveLength(0);
      },
    );
  });

  describe('Giữ chỗ (POST /internal/listings/:id/holds)', () => {
    it('Test 5: tin AVAILABLE → 200 HELD, held_until đúng, held_by_deposit_id, version +1, khớp hợp đồng', async () => {
      const id = await insertListing(pg);
      const depositId = randomUUID();
      const heldUntil = inMinutes(10);
      const res = await hold(id, depositId, heldUntil);
      expect(res.status).toBe(200);
      expect(res.body.data).toEqual({
        listingId: id,
        depositId,
        status: 'HELD',
        heldUntil: heldUntil.toISOString(),
      });
      matches(HOLD_PATH, 'POST', 200, res.body);

      const after = await row(id);
      expect(after.status).toBe('HELD');
      expect(after.held_by_deposit_id).toBe(depositId);
      expect(new Date(after.held_until).getTime()).toBe(heldUntil.getTime());
      expect(after.version).toBe(1);
    });

    it('Test 6 (Báo cáo T06): HELD còn hạn của đơn khác → 409 LISTING_NOT_AVAILABLE, tin không đổi', async () => {
      const owner = randomUUID();
      const id = await held(owner);
      const before = await row(id);
      const res = await hold(id, randomUUID());
      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe('LISTING_NOT_AVAILABLE');
      matches(HOLD_PATH, 'POST', 409, res.body);
      const after = await row(id);
      expect(after.held_by_deposit_id).toBe(owner);
      expect(after.held_until).toEqual(before.held_until);
      expect(after.version).toBe(before.version);
    });

    it.each<[string, FixtureListing]>([
      ['HIDDEN', { status: 'HIDDEN' }],
      ['DEPOSITED', { status: 'DEPOSITED', heldByDepositId: randomUUID() }],
      ['RENTED', { status: 'RENTED', heldByDepositId: randomUUID() }],
      ['chưa duyệt', { approvalStatus: 'PENDING_REVIEW' }],
      ['bị từ chối', { approvalStatus: 'REJECTED' }],
    ])('Test 6: tin %s → 409 LISTING_NOT_AVAILABLE, không đổi', async (_name, over) => {
      const id = await insertListing(pg, over);
      const before = await row(id);
      const res = await hold(id, randomUUID());
      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe('LISTING_NOT_AVAILABLE');
      const after = await row(id);
      expect(after.status).toBe(before.status);
      expect(after.version).toBe(before.version);
    });

    it('không có hoặc đã xóa mềm → 404 LISTING_NOT_FOUND, khớp hợp đồng', async () => {
      const deleted = await insertListing(pg, { deletedAt: new Date() });
      for (const id of [deleted, randomUUID()]) {
        const res = await hold(id, randomUUID());
        expect(res.status).toBe(404);
        expect(res.body.error.code).toBe('LISTING_NOT_FOUND');
        matches(HOLD_PATH, 'POST', 404, res.body);
      }
    });

    it('Test 7 (Báo cáo T07): 50 lời giữ chỗ đồng thời, Postgres thật → đúng một 200, 49 lần 409', async () => {
      const id = await insertListing(pg);
      const deposits = Array.from({ length: 50 }, () => randomUUID());
      const results = await Promise.all(deposits.map((d) => hold(id, d)));

      const winners = results.filter((r) => r.status === 200);
      const losers = results.filter((r) => r.status === 409);
      expect(winners).toHaveLength(1);
      expect(losers).toHaveLength(49);
      for (const l of losers) expect(l.body.error.code).toBe('LISTING_NOT_AVAILABLE');

      const winnerDeposit = winners[0].body.data.depositId as string;
      expect(deposits).toContain(winnerDeposit);
      const after = await row(id);
      expect(after.status).toBe('HELD');
      expect(after.held_by_deposit_id).toBe(winnerDeposit);
      expect(after.version).toBe(1); // chỉ một UPDATE ghi
    });

    it('Test 8: giữ lại cùng depositId → 200, KHÔNG đổi held_until và version', async () => {
      const id = await insertListing(pg);
      const depositId = randomUUID();
      const first = await hold(id, depositId, inMinutes(10));
      const afterFirst = await row(id);
      const second = await hold(id, depositId, inMinutes(30)); // client gửi hạn khác, chỗ giữ cũ vẫn còn hiệu lực
      expect(second.status).toBe(200);
      expect(second.body.data).toEqual(first.body.data);
      matches(HOLD_PATH, 'POST', 200, second.body);
      const afterSecond = await row(id);
      expect(afterSecond.held_until).toEqual(afterFirst.held_until);
      expect(afterSecond.version).toBe(afterFirst.version);
    });

    it('Test 9: tin HELD đã quá held_until → 200 cho đơn mới; cùng đơn cũ cũng được giữ lại (gia hạn)', async () => {
      const oldDeposit = randomUUID();
      const id = await held(oldDeposit, { heldUntil: new Date(Date.now() - 60_000) });
      const newDeposit = randomUUID();
      const res = await hold(id, newDeposit);
      expect(res.status).toBe(200);
      expect((await row(id)).held_by_deposit_id).toBe(newDeposit);

      const id2 = await held(oldDeposit, { heldUntil: new Date(Date.now() - 60_000) });
      const renewed = await hold(id2, oldDeposit, inMinutes(10));
      expect(renewed.status).toBe(200);
      expect(new Date((await row(id2)).held_until).getTime()).toBeGreaterThan(Date.now());
    });

    it('body sai → 400 VALIDATION_FAILED, khớp hợp đồng, tin không đổi', async () => {
      const id = await insertListing(pg);
      const bodies: Array<Record<string, unknown>> = [
        {},
        { depositId: 'khong-phai-uuid', heldUntil: inMinutes(10).toISOString() },
        { depositId: randomUUID(), heldUntil: 'mai' },
        { depositId: randomUUID(), heldUntil: '2026-11-20T08:10:00' }, // thiếu múi giờ
        { depositId: randomUUID(), heldUntil: inMinutes(10).toISOString(), status: 'HELD' }, // trường lạ
      ];
      for (const body of bodies) {
        const res = await t.http().post(`/internal/listings/${id}/holds`).send(body);
        expect(res.status).toBe(400);
        expect(res.body.error.code).toBe('VALIDATION_FAILED');
        matches(HOLD_PATH, 'POST', 400, res.body);
      }
      expect((await row(id)).status).toBe('AVAILABLE');
    });
  });

  describe('Đổi trạng thái (PUT /internal/listings/:id/status)', () => {
    /** [trạng thái ban đầu, đích, trạng thái sau, có xóa giữ chỗ]. */
    const TRANSITIONS: Array<
      ['HELD' | 'DEPOSITED', 'AVAILABLE' | 'DEPOSITED' | 'RENTED', boolean]
    > = [
      ['HELD', 'DEPOSITED', false],
      ['DEPOSITED', 'RENTED', false],
      ['HELD', 'AVAILABLE', true],
      ['DEPOSITED', 'AVAILABLE', true],
    ];

    it.each(TRANSITIONS)(
      'Test 10: %s → %s, gọi hai lần → lần hai 200, không đổi thêm; khớp hợp đồng',
      async (from, to, clears) => {
        const depositId = randomUUID();
        const id = await held(depositId, { status: from });
        const first = await changeStatus(id, depositId, to);
        expect(first.status).toBe(200);
        expect(first.body.data).toEqual({ listingId: id, status: to });
        matches(STATUS_PATH, 'PUT', 200, first.body);
        const afterFirst = await row(id);
        expect(afterFirst.status).toBe(to);
        expect(afterFirst.version).toBe(1);
        if (clears) {
          expect(afterFirst.held_until).toBeNull();
          expect(afterFirst.held_by_deposit_id).toBeNull();
        } else {
          expect(afterFirst.held_by_deposit_id).toBe(depositId);
        }

        const second = await changeStatus(id, depositId, to);
        expect(second.status).toBe(200);
        expect(second.body.data).toEqual({ listingId: id, status: to });
        const afterSecond = await row(id);
        expect(afterSecond.version).toBe(afterFirst.version);
        expect(afterSecond.updated_at).toEqual(afterFirst.updated_at);
      },
    );

    it('đích AVAILABLE: lần gọi lại 200 với MỌI depositId (held_by đã xóa, không còn kiểm được cùng đơn)', async () => {
      const depositId = randomUUID();
      const id = await held(depositId);
      expect((await changeStatus(id, depositId, 'AVAILABLE')).status).toBe(200);
      const again = await changeStatus(id, randomUUID(), 'AVAILABLE');
      expect(again.status).toBe(200);
      expect(again.body.data.status).toBe('AVAILABLE');
    });

    it('HELD hết hạn vẫn đổi được sang DEPOSITED (tiền về sát giờ, rental đã ghi PAID)', async () => {
      const depositId = randomUUID();
      const id = await held(depositId, { heldUntil: new Date(Date.now() - 60_000) });
      expect((await changeStatus(id, depositId, 'DEPOSITED')).status).toBe(200);
      expect((await row(id)).status).toBe('DEPOSITED');
    });

    it('Test 11: tin HELD/DEPOSITED của đơn KHÁC → 409 LISTING_INVALID_STATUS kèm details {current, target}; không đổi', async () => {
      const owner = randomUUID();
      const other = randomUUID();
      const cases: Array<[FixtureListing, string, string]> = [
        [{ status: 'HELD' }, 'AVAILABLE', 'HELD'],
        [{ status: 'HELD' }, 'DEPOSITED', 'HELD'],
        [{ status: 'DEPOSITED' }, 'RENTED', 'DEPOSITED'],
        [{ status: 'DEPOSITED' }, 'AVAILABLE', 'DEPOSITED'],
        [{ status: 'RENTED' }, 'RENTED', 'RENTED'],
      ];
      for (const [over, target, current] of cases) {
        const id = await held(owner, over);
        const before = await row(id);
        const res = await changeStatus(id, other, target);
        expect(res.status).toBe(409);
        expect(res.body.error.code).toBe('LISTING_INVALID_STATUS');
        expect(res.body.error.details).toEqual({ current, target });
        matches(STATUS_PATH, 'PUT', 409, res.body);
        const after = await row(id);
        expect(after.status).toBe(before.status);
        expect(after.held_by_deposit_id).toBe(owner);
        expect(after.version).toBe(before.version);
      }
    });

    it('Test 11: cặp không có trong bảng → 409 dù cùng depositId', async () => {
      const depositId = randomUUID();
      const cases: Array<[FixtureListing, string]> = [
        [{ status: 'HELD' }, 'RENTED'],
        [{ status: 'RENTED' }, 'AVAILABLE'],
        [{ status: 'RENTED' }, 'DEPOSITED'],
      ];
      for (const [over, target] of cases) {
        const id = await held(depositId, over);
        const res = await changeStatus(id, depositId, target);
        expect(res.status).toBe(409);
        expect(res.body.error.code).toBe('LISTING_INVALID_STATUS');
        expect(res.body.error.details).toEqual({ current: over.status, target });
      }
      // AVAILABLE / HIDDEN chưa do đơn nào giữ: không chuyển sang DEPOSITED, RENTED
      for (const over of [{ status: 'AVAILABLE' }, { status: 'HIDDEN' }] as FixtureListing[]) {
        const id = await insertListing(pg, over);
        for (const target of ['DEPOSITED', 'RENTED']) {
          const res = await changeStatus(id, depositId, target);
          expect(res.status).toBe(409);
          expect(res.body.error.details).toEqual({ current: over.status, target });
        }
      }
      const hidden = await insertListing(pg, { status: 'HIDDEN' });
      expect((await changeStatus(hidden, depositId, 'AVAILABLE')).status).toBe(409);
      expect((await row(hidden)).status).toBe('HIDDEN');
    });

    it('đích không hợp lệ (HELD, HIDDEN), thiếu trường, id không phải UUID → 400, khớp hợp đồng', async () => {
      const id = await insertListing(pg);
      for (const status of ['HELD', 'HIDDEN', 'lung-tung']) {
        const res = await changeStatus(id, randomUUID(), status);
        expect(res.status).toBe(400);
        expect(res.body.error.code).toBe('VALIDATION_FAILED');
        matches(STATUS_PATH, 'PUT', 400, res.body);
      }
      const missing = await t.http().put(`/internal/listings/${id}/status`).send({});
      expect(missing.status).toBe(400);
      const bad = await changeStatus('khong-phai-uuid', randomUUID(), 'AVAILABLE');
      expect(bad.status).toBe(400);
      expect(bad.body.error.message).toBe('id phải là UUID');
    });

    it('không có hoặc đã xóa mềm → 404, khớp hợp đồng', async () => {
      const deleted = await insertListing(pg, { deletedAt: new Date() });
      for (const id of [deleted, randomUUID()]) {
        const res = await changeStatus(id, randomUUID(), 'AVAILABLE');
        expect(res.status).toBe(404);
        expect(res.body.error.code).toBe('LISTING_NOT_FOUND');
        matches(STATUS_PATH, 'PUT', 404, res.body);
      }
    });
  });

  describe('Vòng đời đầy đủ và tương tác với API công khai', () => {
    it('AVAILABLE → HELD → DEPOSITED → RENTED, rồi hoàn: DEPOSITED → AVAILABLE giữ chỗ được lại', async () => {
      const id = await insertListing(pg);
      const a = randomUUID();
      expect((await hold(id, a)).status).toBe(200);
      expect((await changeStatus(id, a, 'DEPOSITED')).status).toBe(200);
      expect((await changeStatus(id, a, 'AVAILABLE')).status).toBe(200); // đơn REFUNDED
      const b = randomUUID();
      expect((await hold(id, b)).status).toBe(200); // người khác giữ được sau khi nhả
      expect((await row(id)).held_by_deposit_id).toBe(b);
      expect((await changeStatus(id, b, 'DEPOSITED')).status).toBe(200);
      expect((await changeStatus(id, b, 'RENTED')).status).toBe(200);
      expect((await row(id)).status).toBe('RENTED');
    });

    it('tin đã giữ chỗ vẫn hiện ở GET /api/v1/listings/:id (HELD không phải HIDDEN)', async () => {
      const id = await insertListing(pg);
      await hold(id, randomUUID());
      const res = await t.http().get(`/api/v1/listings/${id}`);
      expect(res.status).toBe(200);
      expect(res.body.data.status).toBe('HELD');
    });
  });

  describe('số truy vấn (non-functional-standards.md §1: ghi ≤ 6, chi tiết ≤ 3)', () => {
    it('bản chụp 1; giữ chỗ 1 (thành công), 2 (gọi lại, 409); đổi trạng thái 1 (thành công), 2 (gọi lại, 409)', async () => {
      const depositId = randomUUID();
      const id = await insertListing(pg);
      expect(await countQueries(() => snapshot(id))).toBe(1);
      expect(await countQueries(() => hold(id, depositId))).toBe(1);
      expect(await countQueries(() => hold(id, depositId))).toBe(2); // gọi lại cùng đơn
      expect(await countQueries(() => hold(id, randomUUID()))).toBe(2); // 409
      expect(await countQueries(() => changeStatus(id, depositId, 'DEPOSITED'))).toBe(1);
      expect(await countQueries(() => changeStatus(id, depositId, 'DEPOSITED'))).toBe(2); // idempotent
      expect(await countQueries(() => changeStatus(id, randomUUID(), 'RENTED'))).toBe(2); // 409
    });
  });
});
