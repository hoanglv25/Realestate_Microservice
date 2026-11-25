import { JwtService } from '@nestjs/jwt';
import { generateKeyPairSync, randomUUID } from 'node:crypto';
import { createServer, IncomingMessage, Server, ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Client } from 'pg';
import { DataSource } from 'typeorm';
import type { DomainEvent } from '../src/messaging/domain-event';
import { EventHandlerRegistry } from '../src/messaging/event-handler.registry';
import { AutoReleaseJob } from '../src/rental/jobs/auto-release.job';
import { DeadlineJob } from '../src/rental/jobs/deadline.job';
import { SagaReconcileJob } from '../src/rental/jobs/saga-reconcile.job';
import { DepositLifecycleService } from '../src/rental/services/deposit-lifecycle.service';
import { expectEventMatchesContract, expectResponseMatchesOpenApi } from './helpers/contracts';
import type { TestApp } from './helpers/create-test-app';
import { INFRA_TEST_SCHEMA, readRootEnv } from './helpers/infra';

/**
 * T3.5 vòng đời đơn (`RE.DEPOSIT_LIFECYCLE`) với Postgres + Redis THẬT; listing và payment là máy chủ HTTP GIẢ (payment
 * chưa có `POST /internal/refund-requests` tới T3.6). Đơn `PAID` dựng thẳng bằng SQL. Sự kiện của payment giao qua
 * handler thật trong transaction (đường RabbitMQ đã kiểm ở `rental.infra-spec`). Các job tắt lịch, test gọi `runOnce()`.
 *
 * DoD: test 1–16 (gồm 13a, 14a, 14b) của `Component_Class_Design §5` — 1 là unit (`deposit-state.spec.ts`); E7 (test 5);
 * số truy vấn mỗi route; sự kiện phát ra khớp `contracts/events`; route nội bộ khớp `rental-internal.v1.yaml`.
 */
const { privateKey, publicKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});
const ISSUER = 'realestate-identity-test';
const ENV_NAMES = [
  'REDIS_URL',
  'JWT_PUBLIC_KEY',
  'JWT_ISSUER',
  'INTERNAL_LISTING_URL',
  'INTERNAL_PAYMENT_URL',
  'OUTBOX_RELAY_ENABLED',
  'PAYMENT_CALL_TIMEOUT_MS',
  'RELEASE_REMINDER_SECONDS',
];
const HOUR = 3600_000;

const envelope = (data: unknown) => ({
  data,
  meta: { correlationId: 'fake', timestamp: new Date().toISOString() },
});

describe('T3.5 vòng đời đơn (hạ tầng thật, listing/payment giả)', () => {
  let t: TestApp;
  let pg: Client;
  let ds: DataSource;
  let listingSrv: Server;
  let paymentSrv: Server;
  const queries: string[] = [];
  const jwt = new JwtService();
  const sign = (sub: string, role: string) =>
    jwt.sign(
      { sub, roles: [role] },
      { privateKey, algorithm: 'RS256', issuer: ISSUER, expiresIn: '1h' },
    );
  const users = {
    tenantA: { id: randomUUID(), role: 'TENANT', token: '' },
    tenantB: { id: randomUUID(), role: 'TENANT', token: '' },
    owner: { id: randomUUID(), role: 'LANDLORD', token: '' },
    otherOwner: { id: randomUUID(), role: 'LANDLORD', token: '' },
    admin: { id: randomUUID(), role: 'ADMIN', token: '' },
  };

  /** `PUT /internal/listings/:id/status` mà listing giả nhận. */
  const statusCalls: Array<{ listingId: string; depositId: string; status: string }> = [];
  /** Số lần payment giả nhận yêu cầu hoàn theo `depositId`. */
  const refundCalls = new Map<string, number>();
  let refundMode: 'ok' | '503' = 'ok';

  async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
    let raw = '';
    for await (const chunk of req) raw += String(chunk);
    return raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
  }
  const send = (res: ServerResponse, status: number, body: unknown) => {
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body));
  };
  const fail = (res: ServerResponse, status: number, code: string) =>
    send(res, status, {
      error: { code, message: code },
      meta: { correlationId: 'fake', timestamp: new Date().toISOString() },
    });

  function listingHandler(req: IncomingMessage, res: ServerResponse): void {
    void (async () => {
      const body = await readJson(req);
      const m = /^\/internal\/listings\/([^/]+)\/status$/.exec(req.url ?? '');
      if (m && req.method === 'PUT') {
        statusCalls.push({
          listingId: m[1],
          depositId: String(body.depositId),
          status: String(body.status),
        });
        return send(
          res,
          200,
          envelope({ listingId: m[1], depositId: body.depositId, status: body.status }),
        );
      }
      return fail(res, 404, 'NOT_FOUND');
    })().catch(() => !res.headersSent && res.writeHead(500).end());
  }

  function paymentHandler(req: IncomingMessage, res: ServerResponse): void {
    void (async () => {
      const body = await readJson(req);
      if (req.url === '/internal/refund-requests' && req.method === 'POST') {
        const depositId = String(body.depositId);
        refundCalls.set(depositId, (refundCalls.get(depositId) ?? 0) + 1);
        if (refundMode === '503') return fail(res, 503, 'PAYMENT_PROVIDER_UNAVAILABLE');
        return send(
          res,
          201,
          envelope({
            refundRequestId: randomUUID(),
            depositId,
            amountVnd: 2_100_000,
            requesterType: 'TENANT',
            status: 'PENDING_ADMIN',
          }),
        );
      }
      return fail(res, 404, 'NOT_FOUND');
    })().catch(() => !res.headersSent && res.writeHead(500).end());
  }

  const listen = (srv: Server) =>
    new Promise<number>((r) =>
      srv.listen(0, '127.0.0.1', () => r((srv.address() as AddressInfo).port)),
    );

  /** Đơn dựng thẳng bằng SQL; mặc định `PAID` 1 giờ trước, còn 47 giờ hoàn, 71 giờ tự giải ngân. */
  async function insertDeposit(
    over: Partial<{
      status: string;
      tenantId: string;
      ownerId: string;
      paidAt: Date;
      refundDeadlineAt: Date;
      autoReleaseAt: Date;
      adminConfirmedAt: Date | null;
      sellerAcknowledgedAt: Date | null;
      createdAt: Date;
    }> = {},
  ): Promise<{ id: string; listingId: string }> {
    const now = Date.now();
    const id = randomUUID();
    const listingId = randomUUID();
    await pg.query(
      `INSERT INTO deposits (id, listing_id, tenant_id, owner_id, listing_title, amount_vnd, status, expires_at,
         paid_at, refund_deadline_at, auto_release_at, admin_confirmed_at, seller_acknowledged_at, created_at)
       VALUES ($1, $2, $3, $4, 'Phòng test T3.5', 3000000, $5, $6, $7, $8, $9, $10, $11, $12)`,
      [
        id,
        listingId,
        over.tenantId ?? users.tenantA.id,
        over.ownerId ?? users.owner.id,
        over.status ?? 'PAID',
        new Date(now - 2 * HOUR),
        over.paidAt ?? new Date(now - HOUR),
        over.refundDeadlineAt ?? new Date(now + 47 * HOUR),
        over.autoReleaseAt ?? new Date(now + 71 * HOUR),
        over.adminConfirmedAt ?? null,
        over.sellerAcknowledgedAt ?? null,
        over.createdAt ?? new Date(),
      ],
    );
    return { id, listingId };
  }
  const row = async (id: string) =>
    (await pg.query(`SELECT * FROM deposits WHERE id = $1`, [id])).rows[0];
  const outbox = async (eventType: string, depositId: string) =>
    (
      await pg.query(
        `SELECT envelope FROM outbox_events WHERE event_type = $1 AND envelope->'payload'->>'depositId' = $2`,
        [eventType, depositId],
      )
    ).rows.map((r: { envelope: DomainEvent<Record<string, unknown>> }) => r.envelope);
  const audit = async (id: string) =>
    (await pg.query(`SELECT * FROM audit_log WHERE target_id = $1`, [id])).rows;

  const as = (u: { token: string }) => ({
    get: (path: string) => t.http().get(path).set('Authorization', `Bearer ${u.token}`),
    post: (path: string, key?: string) => {
      const r = t.http().post(path).set('Authorization', `Bearer ${u.token}`);
      return key ? r.set('Idempotency-Key', key) : r;
    },
  });
  async function countQueries<T>(call: () => Promise<T>): Promise<{ n: number; result: T }> {
    queries.length = 0;
    const result = await call();
    const n = queries.filter(
      (q) =>
        !/^(START TRANSACTION|COMMIT|ROLLBACK)/i.test(q.trim()) &&
        !/published_at IS NULL|UPDATE outbox_events/i.test(q),
    ).length;
    return { n, result };
  }
  /** Giao một sự kiện của payment vào handler thật, trong transaction như `EventConsumer`. */
  async function deliver(eventType: string, payload: Record<string, unknown>): Promise<void> {
    const event: DomainEvent<Record<string, unknown>> = {
      eventId: randomUUID(),
      eventType,
      version: 1,
      occurredAt: new Date().toISOString(),
      correlationId: randomUUID(),
      producer: 'payment',
      payload,
    };
    expectEventMatchesContract(event);
    const handler = t.app.get(EventHandlerRegistry).get(eventType);
    expect(handler).toBeDefined();
    await ds.transaction((m) => handler!(event, m));
  }

  beforeAll(async () => {
    listingSrv = createServer(listingHandler);
    const listingPort = await listen(listingSrv);
    paymentSrv = createServer(paymentHandler);
    const paymentPort = await listen(paymentSrv);

    pg = new Client({ connectionString: process.env.DATABASE_URL });
    await pg.connect();
    await pg.query(`DROP SCHEMA IF EXISTS ${INFRA_TEST_SCHEMA} CASCADE`);
    await pg.query(`CREATE SCHEMA ${INFRA_TEST_SCHEMA}`);

    const root = readRootEnv();
    Object.assign(process.env, {
      SERVICE_NAME: 'rental',
      REDIS_URL: `redis://:${encodeURIComponent(root.REDIS_PASSWORD as string)}@localhost:${root.REDIS_PORT ?? '6379'}`,
      JWT_PUBLIC_KEY: publicKey,
      JWT_ISSUER: ISSUER,
      INTERNAL_LISTING_URL: `http://127.0.0.1:${listingPort}`,
      INTERNAL_PAYMENT_URL: `http://127.0.0.1:${paymentPort}`,
      OUTBOX_RELAY_ENABLED: 'false',
      PAYMENT_CALL_TIMEOUT_MS: '1000',
      RELEASE_REMINDER_SECONDS: '86400',
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
    for (const u of Object.values(users)) u.token = sign(u.id, u.role);
  });

  afterAll(async () => {
    await t?.app.close();
    await pg?.query(`DROP SCHEMA IF EXISTS ${INFRA_TEST_SCHEMA} CASCADE`).catch(() => undefined);
    await pg?.end();
    for (const srv of [listingSrv, paymentSrv]) {
      srv?.closeAllConnections();
      await new Promise((r) => (srv?.listening ? srv.close(r) : r(undefined)));
    }
    for (const name of ENV_NAMES) delete process.env[name];
    process.env.SERVICE_NAME = 'template-nest-test';
  });

  beforeEach(() => {
    statusCalls.length = 0;
    refundMode = 'ok';
  });

  describe('route 2 xem chi tiết (BR-19, chốt T3.5 B2)', () => {
    it('test 16: người thuê A xem đơn của người thuê B -> 403; chủ đơn 200 kèm allowedActions; admin 200; 1 truy vấn', async () => {
      const d = await insertDeposit({ tenantId: users.tenantB.id });
      expect((await as(users.tenantA).get(`/api/v1/deposits/${d.id}`)).status).toBe(403);

      const { n, result: res } = await countQueries(() =>
        as(users.tenantB).get(`/api/v1/deposits/${d.id}`),
      );
      expect(res.status).toBe(200);
      expect(res.body.data).toMatchObject({
        id: d.id,
        status: 'PAID',
        amountVnd: 3_000_000,
        allowedActions: ['CONFIRM_MOVE_IN', 'REQUEST_REFUND'],
      });
      expect(res.body.data).not.toHaveProperty('checkoutUrl');
      expect(n).toBe(1);
      expect(
        (await as(users.admin).get(`/api/v1/deposits/${d.id}`)).body.data.allowedActions,
      ).toEqual(['HAND_OVER']);
    });

    it('chủ tin: chưa bàn giao 403; chủ trọ khác 403; đơn không có 404', async () => {
      const d = await insertDeposit();
      expect((await as(users.owner).get(`/api/v1/deposits/${d.id}`)).status).toBe(403);
      expect((await as(users.otherOwner).get(`/api/v1/deposits/${d.id}`)).status).toBe(403);
      const missing = await as(users.tenantA).get(`/api/v1/deposits/${randomUUID()}`);
      expect(missing.status).toBe(404);
      expect(missing.body.error.code).toBe('RENTAL_DEPOSIT_NOT_FOUND');
    });
  });

  describe('bàn giao và chủ trọ xác nhận (BR-11, B12)', () => {
    it('test 12, 14a: admin bàn giao -> audit_log 1 dòng + deposit-handed-over; gọi lại không thêm; chủ trọ mở được đơn nhưng danh sách chưa có tới khi xác nhận', async () => {
      const owner = { id: randomUUID(), role: 'LANDLORD', token: '' };
      owner.token = sign(owner.id, 'LANDLORD');
      const d = await insertDeposit({ ownerId: owner.id });

      // Admin thấy đơn ở danh sách mặc định (PAID chưa bàn giao)
      const list = await as(users.admin).get('/api/v1/admin/deposits?pageSize=50');
      expect(list.status).toBe(200);
      expect(list.body.data.map((x: { id: string }) => x.id)).toContain(d.id);

      const { n, result: res } = await countQueries(() =>
        as(users.admin).post(`/api/v1/admin/deposits/${d.id}/hand-over`),
      );
      expect(res.status).toBe(200);
      expect(n).toBe(4);
      expect(res.body.data.adminConfirmedAt).not.toBeNull();
      const logs = await audit(d.id);
      expect(logs).toHaveLength(1);
      expect(logs[0]).toMatchObject({
        actor_id: users.admin.id,
        action: 'HAND_OVER',
        target_type: 'DEPOSIT',
        before: { status: 'PAID', adminConfirmedAt: null },
        after: { status: 'PAID', adminConfirmedBy: users.admin.id },
      });
      expect(logs[0].correlation_id).toBeTruthy();
      const [ev] = await outbox('rental.deposit-handed-over', d.id);
      expectEventMatchesContract(ev);
      expect(ev.payload).toMatchObject({
        depositId: d.id,
        ownerId: owner.id,
        adminId: users.admin.id,
      });

      // Gọi lại: 200, không thêm audit_log, không thêm sự kiện
      expect((await as(users.admin).post(`/api/v1/admin/deposits/${d.id}/hand-over`)).status).toBe(
        200,
      );
      expect(await audit(d.id)).toHaveLength(1);
      expect(await outbox('rental.deposit-handed-over', d.id)).toHaveLength(1);

      // Chủ trọ: mở được chi tiết (có ACKNOWLEDGE) nhưng danh sách chưa có (test 12)
      const detail = await as(owner).get(`/api/v1/deposits/${d.id}`);
      expect(detail.status).toBe(200);
      expect(detail.body.data.allowedActions).toEqual(['ACKNOWLEDGE']);
      expect((await as(owner).get('/api/v1/deposits/mine')).body.data).toEqual([]);

      // Xác nhận: 2 truy vấn; vào danh sách
      const ack = await countQueries(() => as(owner).post(`/api/v1/deposits/${d.id}/acknowledge`));
      expect(ack.result.status).toBe(200);
      expect(ack.n).toBe(2);
      const mine = await countQueries(() => as(owner).get('/api/v1/deposits/mine'));
      expect(mine.result.body.data.map((x: { id: string }) => x.id)).toEqual([d.id]);
      expect(mine.result.body.meta).toMatchObject({ page: 1, total: 1 });
      // findAndCount: data + count; TypeORM bỏ câu count khi trang đầu ít hơn pageSize → 1–2 (ngưỡng danh sách 4)
      expect(mine.n).toBeLessThanOrEqual(2);

      // Admin không còn thấy ở danh sách mặc định
      const after = await as(users.admin).get('/api/v1/admin/deposits?pageSize=50');
      expect(after.body.data.map((x: { id: string }) => x.id)).not.toContain(d.id);
    });

    it('test 14b: đơn REFUNDED chưa bàn giao vẫn có trong danh sách chủ trọ; route 5 lọc status', async () => {
      const owner = { id: randomUUID(), role: 'LANDLORD', token: '' };
      owner.token = sign(owner.id, 'LANDLORD');
      const d = await insertDeposit({ ownerId: owner.id, status: 'REFUNDED' });
      const mine = await as(owner).get('/api/v1/deposits/mine');
      expect(mine.body.data.map((x: { id: string }) => x.id)).toEqual([d.id]);

      const filtered = await countQueries(() =>
        as(users.admin).get('/api/v1/admin/deposits?status=REFUNDED'),
      );
      expect(filtered.result.body.data.map((x: { status: string }) => x.status)).toEqual(
        expect.arrayContaining(['REFUNDED']),
      );
      expect(
        filtered.result.body.data.every((x: { status: string }) => x.status === 'REFUNDED'),
      ).toBe(true);
      expect(filtered.n).toBeLessThanOrEqual(2);
    });

    it('test 11: chủ trọ xác nhận trước bàn giao -> 409 RENTAL_NOT_HANDED_OVER', async () => {
      const d = await insertDeposit();
      const res = await as(users.owner).post(`/api/v1/deposits/${d.id}/acknowledge`);
      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe('RENTAL_NOT_HANDED_OVER');
      expect((await row(d.id)).seller_acknowledged_at).toBeNull();
    });

    it('test 10: bàn giao khi REFUND_REQUESTED -> 409 RENTAL_REFUND_PENDING, không audit_log', async () => {
      const d = await insertDeposit({ status: 'REFUND_REQUESTED' });
      const res = await as(users.admin).post(`/api/v1/admin/deposits/${d.id}/hand-over`);
      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe('RENTAL_REFUND_PENDING');
      expect(await audit(d.id)).toHaveLength(0);
    });

    it('quyền: người thuê gọi route admin -> 403; chủ trọ gọi nhận phòng -> 403', async () => {
      const d = await insertDeposit();
      expect(
        (await as(users.tenantA).post(`/api/v1/admin/deposits/${d.id}/hand-over`)).status,
      ).toBe(403);
      expect((await as(users.owner).post(`/api/v1/deposits/${d.id}/confirm-move-in`)).status).toBe(
        403,
      );
    });
  });

  describe('nhận phòng, yêu cầu hoàn (BR-12, BR-13)', () => {
    it('test 9: nhận phòng -> RELEASED trigger TENANT, deposit-released khớp hợp đồng, tin RENTED đã đẩy; 4 truy vấn', async () => {
      const d = await insertDeposit();
      const { n, result: res } = await countQueries(() =>
        as(users.tenantA).post(`/api/v1/deposits/${d.id}/confirm-move-in`),
      );
      expect(res.status).toBe(200);
      expect(res.body.data).toMatchObject({
        status: 'RELEASED',
        releaseTrigger: 'TENANT',
        allowedActions: [],
      });
      expect(n).toBe(4);
      const r = await row(d.id);
      expect(r).toMatchObject({
        status: 'RELEASED',
        release_trigger: 'TENANT',
        listing_target_status: 'RENTED',
      });
      expect(r.listing_synced_at).not.toBeNull();
      expect(statusCalls).toEqual([{ listingId: d.listingId, depositId: d.id, status: 'RENTED' }]);
      const [ev] = await outbox('rental.deposit-released', d.id);
      expectEventMatchesContract(ev);
      expect(ev.payload).toMatchObject({ trigger: 'TENANT' });

      // Bấm lại -> 409
      const again = await as(users.tenantA).post(`/api/v1/deposits/${d.id}/confirm-move-in`);
      expect(again.status).toBe(409);
      expect(again.body.error.code).toBe('RENTAL_INVALID_TRANSITION');
    });

    it('test 2: trong 48 giờ -> REFUND_REQUESTED, payment nhận ĐÚNG MỘT lần, refund_synced_at; gửi lại cùng Idempotency-Key không gọi lần hai; 3 truy vấn', async () => {
      const d = await insertDeposit();
      const key = randomUUID();
      const { n, result: res } = await countQueries(() =>
        as(users.tenantA).post(`/api/v1/deposits/${d.id}/refund-request`, key),
      );
      expect(res.status).toBe(200);
      expect(res.body.data.status).toBe('REFUND_REQUESTED');
      expect(n).toBe(3);
      expect(refundCalls.get(d.id)).toBe(1);
      expect((await row(d.id)).refund_synced_at).not.toBeNull();

      const replay = await as(users.tenantA).post(`/api/v1/deposits/${d.id}/refund-request`, key);
      expect(replay.status).toBe(200);
      expect(replay.headers['idempotent-replayed']).toBe('true');
      expect(refundCalls.get(d.id)).toBe(1);
    });

    it('test 3: sau 48 giờ -> 409 RENTAL_REFUND_WINDOW_CLOSED; sau RELEASED -> 409 RENTAL_INVALID_TRANSITION; đơn không đổi, payment không bị gọi', async () => {
      const late = await insertDeposit({ refundDeadlineAt: new Date(Date.now() - 1000) });
      const r1 = await as(users.tenantA).post(
        `/api/v1/deposits/${late.id}/refund-request`,
        randomUUID(),
      );
      expect(r1.status).toBe(409);
      expect(r1.body.error.code).toBe('RENTAL_REFUND_WINDOW_CLOSED');
      expect((await row(late.id)).status).toBe('PAID');

      const rel = await insertDeposit({ status: 'RELEASED' });
      const r2 = await as(users.tenantA).post(
        `/api/v1/deposits/${rel.id}/refund-request`,
        randomUUID(),
      );
      expect(r2.status).toBe(409);
      expect(r2.body.error.code).toBe('RENTAL_INVALID_TRANSITION');
      expect(refundCalls.has(late.id) || refundCalls.has(rel.id)).toBe(false);
    });

    it('test 4: payment lỗi khi tạo yêu cầu hoàn -> 200, refund_synced_at trống; SagaReconcileJob (c) gửi lại thành công', async () => {
      const d = await insertDeposit();
      refundMode = '503';
      const res = await as(users.tenantA).post(
        `/api/v1/deposits/${d.id}/refund-request`,
        randomUUID(),
      );
      expect(res.status).toBe(200);
      expect(res.body.data.status).toBe('REFUND_REQUESTED');
      expect((await row(d.id)).refund_synced_at).toBeNull();

      await t.app.get(SagaReconcileJob).runOnce(); // vẫn 503
      expect((await row(d.id)).refund_synced_at).toBeNull();

      refundMode = 'ok';
      const r = await t.app.get(SagaReconcileJob).runOnce();
      expect(r.refundSent).toBeGreaterThanOrEqual(1);
      expect((await row(d.id)).refund_synced_at).not.toBeNull();
      const calls = refundCalls.get(d.id) ?? 0;
      await t.app.get(SagaReconcileJob).runOnce(); // đã đánh dấu: không gửi nữa
      expect(refundCalls.get(d.id)).toBe(calls);
    });

    it('test 5 (E7): yêu cầu hoàn ĐỒNG THỜI với AutoReleaseJob trên cùng đơn -> đúng một trạng thái cuối, sự kiện khớp', async () => {
      const auto = t.app.get(AutoReleaseJob);
      const outcomes = { REFUND_REQUESTED: 0, RELEASED: 0 };
      for (let i = 0; i < 10; i++) {
        // Cố tình để cả hai điều kiện cùng đúng: còn hạn hoàn VÀ đã tới mốc tự giải ngân
        const d = await insertDeposit({ autoReleaseAt: new Date(Date.now() - 1000) });
        const [res] = await Promise.all([
          as(users.tenantA).post(`/api/v1/deposits/${d.id}/refund-request`, randomUUID()),
          auto.runOnce(),
        ]);
        const r = await row(d.id);
        expect(['REFUND_REQUESTED', 'RELEASED']).toContain(r.status);
        outcomes[r.status as keyof typeof outcomes]++;
        const released = await outbox('rental.deposit-released', d.id);
        if (r.status === 'RELEASED') {
          expect(res.status).toBe(409);
          expect(released).toHaveLength(1);
          expect(refundCalls.has(d.id)).toBe(false);
        } else {
          expect(res.status).toBe(200);
          expect(released).toHaveLength(0);
          expect(refundCalls.get(d.id)).toBe(1);
        }
      }
      expect(outcomes.REFUND_REQUESTED + outcomes.RELEASED).toBe(10);
    });

    it('test 5 (E7, khe đua cố định): yêu cầu hoàn chen vào GIỮA lúc AutoReleaseJob đọc đơn và lúc UPDATE -> job bỏ qua, đơn REFUND_REQUESTED', async () => {
      const auto = t.app.get(AutoReleaseJob);
      const d = await insertDeposit({ autoReleaseAt: new Date(Date.now() - 1000) });
      const repo = (
        auto as unknown as { deposits: { find: (...a: unknown[]) => Promise<unknown> } }
      ).deposits;
      const original = repo.find.bind(repo);
      let refundStatus = 0;
      const spy = jest.spyOn(repo, 'find').mockImplementationOnce(async (...args: unknown[]) => {
        const rows = await original(...args); // job đã thấy đơn PAID
        refundStatus = (
          await as(users.tenantA).post(`/api/v1/deposits/${d.id}/refund-request`, randomUUID())
        ).status; // người thuê thắng trước khi job UPDATE
        return rows;
      });
      try {
        const r = await auto.runOnce();
        expect(refundStatus).toBe(200);
        expect(r.skipped).toBeGreaterThanOrEqual(1);
      } finally {
        spy.mockRestore();
      }
      expect((await row(d.id)).status).toBe('REFUND_REQUESTED');
      expect(await outbox('rental.deposit-released', d.id)).toHaveLength(0);
    });

    it('test 5 (E7, khe đua cố định): AutoReleaseJob chen vào GIỮA lúc yêu cầu hoàn đọc đơn và lúc UPDATE -> 409, đơn RELEASED, payment không bị gọi', async () => {
      const auto = t.app.get(AutoReleaseJob);
      const d = await insertDeposit({ autoReleaseAt: new Date(Date.now() - 1000) });
      const lifecycle = t.app.get(DepositLifecycleService);
      const repo = (
        lifecycle as unknown as { deposits: { findOneBy: (...a: unknown[]) => Promise<unknown> } }
      ).deposits;
      const original = repo.findOneBy.bind(repo);
      const spy = jest
        .spyOn(repo, 'findOneBy')
        .mockImplementationOnce(async (...args: unknown[]) => {
          const found = await original(...args); // route 4 đã thấy đơn PAID, còn hạn hoàn
          await auto.runOnce(); // job thắng trước khi route 4 UPDATE
          return found;
        });
      try {
        const res = await as(users.tenantA).post(
          `/api/v1/deposits/${d.id}/refund-request`,
          randomUUID(),
        );
        expect(res.status).toBe(409);
        expect(res.body.error.code).toBe('RENTAL_INVALID_TRANSITION');
      } finally {
        spy.mockRestore();
      }
      expect((await row(d.id)).status).toBe('RELEASED');
      expect(refundCalls.has(d.id)).toBe(false);
    });
  });

  describe('sự kiện của payment (handler thật)', () => {
    it('test 6: payment.refunded TENANT -> REFUNDED, đích AVAILABLE; job (b) đẩy AVAILABLE sang listing', async () => {
      const d = await insertDeposit({ status: 'REFUND_REQUESTED' });
      await deliver('payment.refunded', {
        depositId: d.id,
        refundRequestId: randomUUID(),
        tenantId: users.tenantA.id,
        ownerId: users.owner.id,
        amountVnd: 2_100_000,
        requesterType: 'TENANT',
      });
      const r = await row(d.id);
      expect(r).toMatchObject({
        status: 'REFUNDED',
        listing_target_status: 'AVAILABLE',
        listing_synced_at: null,
      });
      expect(r.refunded_at).not.toBeNull();

      await t.app.get(SagaReconcileJob).runOnce();
      expect(statusCalls).toContainEqual({
        listingId: d.listingId,
        depositId: d.id,
        status: 'AVAILABLE',
      });
      expect((await row(d.id)).listing_synced_at).not.toBeNull();
    });

    it('test 7: payment.refunded SYSTEM cho đơn EXPIRED -> không đổi', async () => {
      const d = await insertDeposit({ status: 'EXPIRED' });
      await deliver('payment.refunded', {
        depositId: d.id,
        refundRequestId: randomUUID(),
        tenantId: users.tenantA.id,
        ownerId: users.owner.id,
        amountVnd: 3_000_000,
        requesterType: 'SYSTEM',
      });
      expect(await row(d.id)).toMatchObject({ status: 'EXPIRED', refunded_at: null });
    });

    it('test 8: payment.refund-rejected -> PAID; đã quá 72 giờ thì lượt AutoReleaseJob sau -> RELEASED AUTO, tin RENTED', async () => {
      const d = await insertDeposit({
        status: 'REFUND_REQUESTED',
        autoReleaseAt: new Date(Date.now() - 1000),
      });
      await deliver('payment.refund-rejected', {
        depositId: d.id,
        refundRequestId: randomUUID(),
        tenantId: users.tenantA.id,
        ownerId: users.owner.id,
        reason: 'Đã nhận phòng',
      });
      expect((await row(d.id)).status).toBe('PAID');

      await t.app.get(AutoReleaseJob).runOnce();
      expect(await row(d.id)).toMatchObject({ status: 'RELEASED', release_trigger: 'AUTO' });
      expect(statusCalls).toContainEqual({
        listingId: d.listingId,
        depositId: d.id,
        status: 'RENTED',
      });
      const [ev] = await outbox('rental.deposit-released', d.id);
      expectEventMatchesContract(ev);
      expect(ev.payload).toMatchObject({ trigger: 'AUTO' });
    });

    it('test 14: payment.withdrawal-completed: RELEASED -> WITHDRAWN; REFUNDED giữ nguyên, có withdrawn_at', async () => {
      const rel = await insertDeposit({ status: 'RELEASED' });
      const refd = await insertDeposit({ status: 'REFUNDED' });
      for (const d of [rel, refd]) {
        await deliver('payment.withdrawal-completed', {
          withdrawalId: randomUUID(),
          depositId: d.id,
          ownerId: users.owner.id,
          amountVnd: 900_000,
        });
      }
      expect(await row(rel.id)).toMatchObject({ status: 'WITHDRAWN' });
      expect((await row(rel.id)).withdrawn_at).not.toBeNull();
      expect(await row(refd.id)).toMatchObject({ status: 'REFUNDED' });
      expect((await row(refd.id)).withdrawn_at).not.toBeNull();
    });
  });

  describe('withdrawal-eligibility (payment hỏi, BR-15 sửa)', () => {
    const get = (id: string) => t.http().get(`/internal/deposits/${id}/withdrawal-eligibility`);
    const PATH = '/internal/deposits/{id}/withdrawal-eligibility';

    it('test 13: RELEASED thiếu từng mốc -> missing đúng; đủ hai mốc -> eligible; khớp rental-internal.v1.yaml; 1 truy vấn', async () => {
      const none = await insertDeposit({ status: 'RELEASED' });
      const handed = await insertDeposit({ status: 'RELEASED', adminConfirmedAt: new Date() });
      const both = await insertDeposit({
        status: 'RELEASED',
        adminConfirmedAt: new Date(),
        sellerAcknowledgedAt: new Date(),
      });
      const paid = await insertDeposit();

      const { n, result: r1 } = await countQueries(() => get(none.id));
      expect(n).toBe(1);
      expect(r1.status).toBe(200);
      expectResponseMatchesOpenApi('rental-internal.v1.yaml', 'GET', PATH, 200, r1.body);
      expect(r1.body.data).toMatchObject({
        eligible: false,
        missing: ['NOT_HANDED_OVER', 'NOT_ACKNOWLEDGED'],
      });
      expect((await get(handed.id)).body.data).toMatchObject({
        eligible: false,
        missing: ['NOT_ACKNOWLEDGED'],
      });
      expect((await get(both.id)).body.data).toMatchObject({
        depositId: both.id,
        ownerId: users.owner.id,
        amountVnd: 3_000_000,
        status: 'RELEASED',
        eligible: true,
        missing: [],
      });
      expect((await get(paid.id)).body.data).toMatchObject({
        eligible: false,
        missing: ['NOT_RELEASED'],
      });
    });

    it('test 13a: REFUNDED chưa bàn giao -> eligible; đơn không có -> 404 khớp hợp đồng', async () => {
      const d = await insertDeposit({ status: 'REFUNDED' });
      expect((await get(d.id)).body.data).toMatchObject({
        status: 'REFUNDED',
        eligible: true,
        missing: [],
      });
      const missing = await get(randomUUID());
      expect(missing.status).toBe(404);
      expectResponseMatchesOpenApi('rental-internal.v1.yaml', 'GET', PATH, 404, missing.body);
    });
  });

  describe('DeadlineJob (BR-13, nhắc trước 24 giờ)', () => {
    it('test 15: đơn còn < 24 giờ tới mốc tự giải ngân -> MỘT rental.release-reminder khớp hợp đồng; lượt sau không phát lại; đơn còn xa không nhắc', async () => {
      const job = t.app.get(DeadlineJob);
      const soon = await insertDeposit({ autoReleaseAt: new Date(Date.now() + HOUR) });
      const far = await insertDeposit({ autoReleaseAt: new Date(Date.now() + 30 * HOUR) });

      await job.runOnce();
      const [ev, ...rest] = await outbox('rental.release-reminder', soon.id);
      expect(rest).toHaveLength(0);
      expectEventMatchesContract(ev);
      expect((await row(soon.id)).release_reminded_at).not.toBeNull();
      expect(await outbox('rental.release-reminder', far.id)).toHaveLength(0);

      await job.runOnce();
      expect(await outbox('rental.release-reminder', soon.id)).toHaveLength(1);
    });
  });
});
