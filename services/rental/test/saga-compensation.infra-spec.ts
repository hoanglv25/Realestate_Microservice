import { JwtService } from '@nestjs/jwt';
import { generateKeyPairSync, randomUUID } from 'node:crypto';
import { createServer, IncomingMessage, Server, ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Client } from 'pg';
import { DataSource } from 'typeorm';
import type { DomainEvent } from '../src/messaging/domain-event';
import { SagaReconcileJob } from '../src/rental/jobs/saga-reconcile.job';
import { expectEventMatchesContract } from './helpers/contracts';
import type { TestApp } from './helpers/create-test-app';
import { INFRA_TEST_SCHEMA, readRootEnv } from './helpers/infra';

/**
 * T3.3 với Postgres + Redis THẬT; listing và payment là máy chủ HTTP GIẢ trên HAI cổng riêng (đóng cổng payment để
 * giả lập "payment dừng" → lỗi kết nối → `NOT_EXECUTED`). `SagaReconcileJob` tắt lịch (setup-infra-env), test gọi
 * `runOnce()`.
 *
 * DoD: test 5, 7, 8, 17 của `RE.DEPOSIT_SAGA/Component_Class_Design.md §8` (3, 4, 6 đã có ở rental.infra-spec),
 * C20 (`409 LISTING_INVALID_STATUS` → kết cục cuối), `PAID` → tin `DEPOSITED`, số truy vấn nhánh bù trừ 7.
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
  'SAGA_STUCK_AFTER_SECONDS',
  'PAYMENT_CALL_TIMEOUT_MS',
];

const envelope = (data: unknown) => ({
  data,
  meta: { correlationId: 'fake', timestamp: new Date().toISOString() },
});

describe('T3.3 bù trừ, đối soát, đồng bộ listing (hạ tầng thật, listing/payment giả)', () => {
  let t: TestApp;
  let pg: Client;
  let ds: DataSource;
  let job: SagaReconcileJob;
  let listingSrv: Server;
  let paymentSrv: Server;
  let paymentPort = 0;
  const queries: string[] = [];
  const jwt = new JwtService();
  const tenant = { id: randomUUID(), token: '' };
  const ownerId = randomUUID();

  /** Trạng thái tin ở listing giả. */
  const listingStatus = new Map<string, string>();
  const statusCalls: Array<{ listingId: string; depositId: string; status: string }> = [];
  /** Hành vi `PUT /status`: ok | 503 | 409 (tin thuộc đơn khác). */
  let statusMode: 'ok' | '503' | '409' = 'ok';
  /** Hành vi tạo order: ok | 409 (payment từ chối) | 504 (không rõ). */
  let createMode: 'ok' | '409' | '504' = 'ok';
  /** `GET /internal/payment-orders/:depositId`: order theo đơn; không có → 404. */
  const orders = new Map<string, { orderId: string; checkoutUrl: string }>();

  async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
    let raw = '';
    for await (const chunk of req) raw += String(chunk);
    return raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
  }
  const send = (res: ServerResponse, status: number, body: unknown) => {
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body));
  };
  const fail = (res: ServerResponse, status: number, code: string, details?: unknown) =>
    send(res, status, {
      error: { code, message: code, ...(details ? { details } : {}) },
      meta: { correlationId: 'fake', timestamp: new Date().toISOString() },
    });

  function listingHandler(req: IncomingMessage, res: ServerResponse): void {
    void (async () => {
      const body = await readJson(req);
      const path = req.url ?? '';
      let m = /^\/internal\/listings\/([^/]+)$/.exec(path);
      if (m) {
        return send(
          res,
          200,
          envelope({
            id: m[1],
            ownerId,
            title: 'Phòng test T3.3',
            depositAmountVnd: 2_000,
            status: listingStatus.get(m[1]) ?? 'AVAILABLE',
            approvalStatus: 'APPROVED',
          }),
        );
      }
      m = /^\/internal\/listings\/([^/]+)\/holds$/.exec(path);
      if (m) {
        listingStatus.set(m[1], 'HELD');
        return send(
          res,
          200,
          envelope({
            listingId: m[1],
            depositId: body.depositId,
            status: 'HELD',
            heldUntil: body.heldUntil,
          }),
        );
      }
      m = /^\/internal\/listings\/([^/]+)\/status$/.exec(path);
      if (m) {
        statusCalls.push({
          listingId: m[1],
          depositId: String(body.depositId),
          status: String(body.status),
        });
        if (statusMode === '503') return fail(res, 503, 'DEPENDENCY_UNAVAILABLE');
        if (statusMode === '409') {
          return fail(res, 409, 'LISTING_INVALID_STATUS', {
            current: 'HELD',
            target: String(body.status),
          });
        }
        listingStatus.set(m[1], String(body.status));
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
      const path = req.url ?? '';
      if (path === '/internal/payment-orders' && req.method === 'POST') {
        if (createMode === '409') return fail(res, 409, 'PAYMENT_ORDER_EXPIRED');
        if (createMode === '504') return fail(res, 504, 'UPSTREAM_TIMEOUT');
        const o = {
          orderId: randomUUID(),
          checkoutUrl: `https://pay.payos.vn/web/${String(body.depositId)}`,
        };
        orders.set(String(body.depositId), o);
        return send(
          res,
          201,
          envelope({ ...o, payosOrderCode: 100001, qrCode: '000201', expiresAt: body.expiresAt }),
        );
      }
      const m = /^\/internal\/payment-orders\/([^/]+)$/.exec(path);
      if (m && req.method === 'GET') {
        const o = orders.get(m[1]);
        if (!o) return fail(res, 404, 'PAYMENT_ORDER_NOT_FOUND');
        return send(
          res,
          200,
          envelope({
            ...o,
            depositId: m[1],
            status: 'PENDING',
            amountVnd: 2_000,
            payosOrderCode: 100001,
            expiresAt: new Date(Date.now() + 600_000).toISOString(),
            paidAt: null,
          }),
        );
      }
      return fail(res, 404, 'NOT_FOUND');
    })().catch(() => !res.headersSent && res.writeHead(500).end());
  }

  const listen = (srv: Server, port = 0) =>
    new Promise<number>((r) =>
      srv.listen(port, '127.0.0.1', () => r((srv.address() as AddressInfo).port)),
    );
  async function stopPayment(): Promise<void> {
    paymentSrv.closeAllConnections();
    await new Promise((r) => paymentSrv.close(r));
  }
  async function startPayment(): Promise<void> {
    paymentSrv = createServer(paymentHandler);
    await listen(paymentSrv, paymentPort);
  }

  const deposit = async (id: string) =>
    (await pg.query(`SELECT * FROM deposits WHERE id = $1`, [id])).rows[0];
  const sagaLog = async (depositId: string) =>
    (
      await pg.query(
        `SELECT step, outcome, detail FROM saga_log WHERE deposit_id = $1 ORDER BY created_at`,
        [depositId],
      )
    ).rows;
  const outbox = async (eventType: string, depositId: string) =>
    (
      await pg.query(
        `SELECT envelope FROM outbox_events WHERE event_type = $1 AND envelope->'payload'->>'depositId' = $2`,
        [eventType, depositId],
      )
    ).rows.map((r: { envelope: DomainEvent<Record<string, unknown>> }) => r.envelope);
  const startDeposit = (listingId: string) =>
    t
      .http()
      .post('/api/v1/deposits')
      .set('Authorization', `Bearer ${tenant.token}`)
      .set('Idempotency-Key', randomUUID())
      .send({ listingId });
  /** Đơn PENDING_PAYMENT chưa có order (tạo order 504), lùi created_at để job (a) coi là kẹt. */
  async function stuckDeposit(): Promise<{ id: string; listingId: string }> {
    const listingId = randomUUID();
    createMode = '504';
    const res = await startDeposit(listingId);
    createMode = 'ok';
    expect(res.status).toBe(504);
    const { rows } = await pg.query(
      `UPDATE deposits SET created_at = now() - interval '5 minutes' WHERE listing_id = $1 RETURNING id`,
      [listingId],
    );
    return { id: rows[0].id, listingId };
  }
  async function countQueries(call: () => Promise<unknown>): Promise<number> {
    queries.length = 0;
    await call();
    return queries.filter(
      (q) =>
        !/^(START TRANSACTION|COMMIT|ROLLBACK)/i.test(q.trim()) &&
        !/published_at IS NULL|UPDATE outbox_events/i.test(q),
    ).length;
  }

  beforeAll(async () => {
    listingSrv = createServer(listingHandler);
    const listingPort = await listen(listingSrv);
    paymentSrv = createServer(paymentHandler);
    paymentPort = await listen(paymentSrv);

    pg = new Client({ connectionString: process.env.DATABASE_URL });
    await pg.connect();
    await pg.query(`DROP SCHEMA IF EXISTS ${INFRA_TEST_SCHEMA} CASCADE`);
    await pg.query(`CREATE SCHEMA ${INFRA_TEST_SCHEMA}`);

    const root = readRootEnv();
    Object.assign(process.env, {
      SERVICE_NAME: 'rental', // producer của sự kiện (contracts/events)
      REDIS_URL: `redis://:${encodeURIComponent(root.REDIS_PASSWORD as string)}@localhost:${root.REDIS_PORT ?? '6379'}`,
      JWT_PUBLIC_KEY: publicKey,
      JWT_ISSUER: ISSUER,
      INTERNAL_LISTING_URL: `http://127.0.0.1:${listingPort}`,
      INTERNAL_PAYMENT_URL: `http://127.0.0.1:${paymentPort}`,
      OUTBOX_RELAY_ENABLED: 'false',
      SAGA_STUCK_AFTER_SECONDS: '30',
      PAYMENT_CALL_TIMEOUT_MS: '1000',
    });
    const { createTestApp } = await import('./helpers/create-test-app');
    t = await createTestApp();
    ds = t.app.get(DataSource);
    await ds.runMigrations();
    job = t.app.get(SagaReconcileJob);
    const noop = () => undefined;
    (ds as unknown as { logger: unknown }).logger = {
      logQuery: (q: string) => queries.push(q),
      logQueryError: noop,
      logQuerySlow: noop,
      logSchemaBuild: noop,
      logMigration: noop,
      log: noop,
    };
    tenant.token = jwt.sign(
      { sub: tenant.id, roles: ['TENANT'] },
      { privateKey, algorithm: 'RS256', issuer: ISSUER, expiresIn: '1h' },
    );
  });

  afterAll(async () => {
    await t?.app.close();
    await pg?.query(`DROP SCHEMA IF EXISTS ${INFRA_TEST_SCHEMA} CASCADE`).catch(() => undefined);
    await pg?.end();
    listingSrv?.closeAllConnections();
    paymentSrv?.closeAllConnections();
    await new Promise((r) => listingSrv?.close(r));
    await new Promise((r) => (paymentSrv?.listening ? paymentSrv.close(r) : r(undefined)));
    for (const name of ENV_NAMES) delete process.env[name];
    process.env.SERVICE_NAME = 'template-nest-test';
  });

  beforeEach(() => {
    statusMode = 'ok';
    createMode = 'ok';
    statusCalls.length = 0;
  });

  describe('test 5: tạo order thất bại chắc chắn -> bù trừ ngay', () => {
    it('payment 4xx -> client nhận nguyên 409; đơn CANCELLED (PAYMENT_ORDER_REJECTED), đích AVAILABLE ĐÃ đẩy; saga_log; deposit-cancelled khớp hợp đồng', async () => {
      const listingId = randomUUID();
      createMode = '409';
      const res = await startDeposit(listingId);

      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe('PAYMENT_ORDER_EXPIRED');
      const { rows } = await pg.query(`SELECT * FROM deposits WHERE listing_id = $1`, [listingId]);
      const d = rows[0];
      expect(d).toMatchObject({
        status: 'CANCELLED',
        cancelled_reason: 'PAYMENT_ORDER_REJECTED',
        listing_target_status: 'AVAILABLE',
      });
      expect(d.listing_synced_at).not.toBeNull();
      expect(listingStatus.get(listingId)).toBe('AVAILABLE');
      expect(statusCalls).toEqual([{ listingId, depositId: d.id, status: 'AVAILABLE' }]);
      expect((await sagaLog(d.id)).map((l) => `${l.step}:${l.outcome}`)).toEqual([
        'HOLD_LISTING:OK',
        'CREATE_PAYMENT_ORDER:BUSINESS_ERROR',
      ]);
      const [ev] = await outbox('rental.deposit-cancelled', d.id);
      expectEventMatchesContract(ev);
      expect(ev.payload).toEqual({ depositId: d.id, listingId, tenantId: tenant.id, ownerId });
    });

    it('payment DỪNG (cổng đóng, chưa gửi được) -> 503; đơn CANCELLED (PAYMENT_UNAVAILABLE), tin AVAILABLE; số truy vấn nhánh bù trừ 7 (A chấp nhận)', async () => {
      const listingId = randomUUID();
      await stopPayment();
      try {
        let status = 0;
        const n = await countQueries(async () => (status = (await startDeposit(listingId)).status));
        expect(status).toBe(503);
        expect(n).toBe(7);
      } finally {
        await startPayment();
      }
      const { rows } = await pg.query(`SELECT * FROM deposits WHERE listing_id = $1`, [listingId]);
      expect(rows[0]).toMatchObject({
        status: 'CANCELLED',
        cancelled_reason: 'PAYMENT_UNAVAILABLE',
      });
      expect(listingStatus.get(listingId)).toBe('AVAILABLE');
      expect((await sagaLog(rows[0].id)).at(-1)).toMatchObject({
        step: 'CREATE_PAYMENT_ORDER',
        outcome: 'NOT_EXECUTED',
      });
    });
  });

  describe('SagaReconcileJob (a): đơn kẹt chưa có order', () => {
    it('test 7: payment CÓ order (đã tạo dù rental nhận 504) -> gắn payment_order_id, checkout_url; saga_log OK (reconcile)', async () => {
      const d = await stuckDeposit();
      const o = { orderId: randomUUID(), checkoutUrl: `https://pay.payos.vn/web/${d.id}` };
      orders.set(d.id, o);

      const r = await job.runOnce();

      expect(r.attached).toBeGreaterThanOrEqual(1);
      expect(await deposit(d.id)).toMatchObject({
        status: 'PENDING_PAYMENT',
        payment_order_id: o.orderId,
        checkout_url: o.checkoutUrl,
      });
      expect((await sagaLog(d.id)).at(-1)).toMatchObject({
        step: 'CREATE_PAYMENT_ORDER',
        outcome: 'OK',
        detail: { via: 'reconcile' },
      });
    });

    it('test 8 (E8): payment KHÔNG có order (404) -> CANCELLED (PAYMENT_ORDER_NOT_FOUND), tin về AVAILABLE, deposit-cancelled', async () => {
      const d = await stuckDeposit();
      orders.delete(d.id);

      await job.runOnce();

      expect(await deposit(d.id)).toMatchObject({
        status: 'CANCELLED',
        cancelled_reason: 'PAYMENT_ORDER_NOT_FOUND',
      });
      expect(listingStatus.get(d.listingId)).toBe('AVAILABLE');
      expect(await outbox('rental.deposit-cancelled', d.id)).toHaveLength(1);
    });

    it('đơn mới tạo (chưa quá SAGA_STUCK_AFTER_SECONDS) -> job không đụng tới', async () => {
      const listingId = randomUUID();
      createMode = '504';
      await startDeposit(listingId);
      createMode = 'ok';
      await job.runOnce();
      const { rows } = await pg.query(`SELECT * FROM deposits WHERE listing_id = $1`, [listingId]);
      expect(rows[0]).toMatchObject({ status: 'PENDING_PAYMENT', payment_order_id: null });
    });
  });

  describe('SagaReconcileJob (b): đẩy đích listing', () => {
    it('test 17: listing 503 lúc bù trừ và lượt job đầu -> chưa đánh dấu, không ghi saga_log mỗi lượt; listing hồi -> lượt sau đẩy xong', async () => {
      const listingId = randomUUID();
      statusMode = '503';
      createMode = '409';
      await startDeposit(listingId);
      const { rows } = await pg.query(`SELECT id FROM deposits WHERE listing_id = $1`, [listingId]);
      const id = rows[0].id as string;
      expect((await deposit(id)).listing_synced_at).toBeNull();
      expect(listingStatus.get(listingId)).toBe('HELD');

      await job.runOnce(); // vẫn 503
      expect((await deposit(id)).listing_synced_at).toBeNull();
      expect((await sagaLog(id)).filter((l) => l.step === 'SYNC_LISTING')).toHaveLength(0);

      statusMode = 'ok';
      await job.runOnce();
      expect((await deposit(id)).listing_synced_at).not.toBeNull();
      expect(listingStatus.get(listingId)).toBe('AVAILABLE');
    });

    it('đơn PAID (payment.deposited đặt đích DEPOSITED) -> job đẩy DEPOSITED sang listing (sửa tin còn HELD sau PAID)', async () => {
      const listingId = randomUUID();
      const res = await startDeposit(listingId);
      const id = res.body.data.depositId as string;
      await pg.query(
        `UPDATE deposits SET status = 'PAID', paid_at = now(), listing_target_status = 'DEPOSITED', listing_synced_at = NULL WHERE id = $1`,
        [id],
      );

      await job.runOnce();

      expect(listingStatus.get(listingId)).toBe('DEPOSITED');
      expect(statusCalls.at(-1)).toEqual({ listingId, depositId: id, status: 'DEPOSITED' });
      expect((await deposit(id)).listing_synced_at).not.toBeNull();
    });

    it('C20: listing 409 LISTING_INVALID_STATUS (tin đã thuộc đơn khác) -> kết cục cuối: đánh dấu, saga_log SYNC_LISTING BUSINESS_ERROR kèm details; lượt sau KHÔNG đẩy lại', async () => {
      const listingId = randomUUID();
      statusMode = '503';
      createMode = '409';
      await startDeposit(listingId); // bù trừ, chưa đẩy được
      const { rows } = await pg.query(`SELECT id FROM deposits WHERE listing_id = $1`, [listingId]);
      const id = rows[0].id as string;

      statusMode = '409';
      await job.runOnce();
      expect((await deposit(id)).listing_synced_at).not.toBeNull();
      expect((await sagaLog(id)).at(-1)).toMatchObject({
        step: 'SYNC_LISTING',
        outcome: 'BUSINESS_ERROR',
        detail: {
          code: 'LISTING_INVALID_STATUS',
          status: 409,
          details: { current: 'HELD', target: 'AVAILABLE' },
        },
      });

      statusCalls.length = 0;
      await job.runOnce();
      expect(statusCalls.filter((c) => c.depositId === id)).toHaveLength(0);
    });
  });
});
