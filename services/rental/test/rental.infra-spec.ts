import { JwtService } from '@nestjs/jwt';
import amqplib, { Channel, ChannelModel } from 'amqplib';
import { generateKeyPairSync, randomUUID } from 'node:crypto';
import { createServer, IncomingMessage, Server, ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Client } from 'pg';
import { DataSource } from 'typeorm';
import type { DomainEvent } from '../src/messaging/domain-event';
import { expectEventMatchesContract } from './helpers/contracts';
import type { TestApp } from './helpers/create-test-app';
import { INFRA_TEST_SCHEMA, readRootEnv } from './helpers/infra';

/**
 * Saga đặt cọc (luồng thành công) và lịch xem với Postgres, Redis, RabbitMQ THẬT; listing và payment là máy chủ
 * HTTP GIẢ trả đúng khung `{ data, meta }` và hình dạng của `contracts/openapi/*-internal.v1.yaml`.
 *
 * DoD T3.2: test 1, 2, 9, 14, 15, 18 (`RE.DEPOSIT_SAGA/Component_Class_Design.md §8`) và test 1–10
 * (`RE.VIEWING/Component_Class_Design.md §3`). `payment.deposited` đi qua RabbitMQ thật vào `EventConsumer`.
 */
const { privateKey, publicKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});
const ISSUER = 'realestate-identity-test';
const EXCHANGE = 'domain.events';
const DLX = 'domain.events.dlx';
const QUEUE = `rental.infra-test.${randomUUID().slice(0, 8)}`;
const DLQ = `${QUEUE}.dlq`;
const HOLD_TTL_SECONDS = 600;
const ENV_NAMES = [
  'REDIS_URL',
  'JWT_PUBLIC_KEY',
  'JWT_ISSUER',
  'INTERNAL_LISTING_URL',
  'INTERNAL_PAYMENT_URL',
  'RABBITMQ_QUEUE',
  'OUTBOX_RELAY_ENABLED',
  'HOLD_TTL_SECONDS',
  'RABBITMQ_MAX_RETRIES',
];

interface FakeListing {
  id: string;
  ownerId: string;
  title: string;
  depositAmountVnd: number;
  status: string;
  approvalStatus: string;
  heldBy?: string;
}

const envelope = (data: unknown) => ({
  data,
  meta: { correlationId: 'fake', timestamp: new Date().toISOString() },
});

describe('rental với hạ tầng thật (listing, payment giả)', () => {
  let t: TestApp;
  let pg: Client;
  let ds: DataSource;
  let amqp: ChannelModel;
  let channel: Channel;
  let upstream: Server;
  const queries: string[] = [];
  const jwt = new JwtService();

  const listings = new Map<string, FakeListing>();
  const calls: Array<{ method: string; path: string; body: Record<string, unknown> }> = [];
  /** payment giả trả lỗi `paymentFailStatus` cho `paymentFailTimes` lần tạo order kế tiếp (wrapper có retry). */
  let paymentFailStatus = 0;
  let paymentFailTimes = 0;
  /** listing giả cho giữ chỗ dù tin đang HELD (giả lập listing lệch với rental, để chạm lớp chặn 3). */
  let holdAlwaysOk = false;
  /** listing giả trả 409 cho lần giữ chỗ kế tiếp (người khác vừa giữ). */
  let holdConflict = false;

  const owner = { id: randomUUID(), token: '' };
  const otherOwner = { id: randomUUID(), token: '' };
  const tenants = Array.from({ length: 4 }, () => ({ id: randomUUID(), token: '' }));
  const sign = (sub: string, role: string) =>
    jwt.sign(
      { sub, roles: [role] },
      { privateKey, algorithm: 'RS256', issuer: ISSUER, expiresIn: '1h' },
    );
  const as = (token: string) => ({
    get: (path: string) => t.http().get(path).set('Authorization', `Bearer ${token}`),
    post: (path: string, body?: object, headers: Record<string, string> = {}) =>
      t.http().post(path).set('Authorization', `Bearer ${token}`).set(headers).send(body),
  });

  function newListing(over: Partial<FakeListing> = {}): FakeListing {
    const l: FakeListing = {
      id: randomUUID(),
      ownerId: owner.id,
      title: 'Phòng 25m2 gần ĐH Bách Khoa',
      depositAmountVnd: 3_000_000,
      status: 'AVAILABLE',
      approvalStatus: 'APPROVED',
      ...over,
    };
    listings.set(l.id, l);
    return l;
  }

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

  /** listing + payment giả trên cùng một cổng (đường dẫn khác nhau). */
  function handle(req: IncomingMessage, res: ServerResponse): void {
    void (async () => {
      const body = await readJson(req);
      const path = req.url ?? '';
      calls.push({ method: req.method ?? '', path, body });
      let m = /^\/internal\/listings\/([^/]+)$/.exec(path);
      if (m && req.method === 'GET') {
        const l = listings.get(m[1]);
        if (!l) return fail(res, 404, 'LISTING_NOT_FOUND');
        const snapshot = {
          id: l.id,
          ownerId: l.ownerId,
          title: l.title,
          depositAmountVnd: l.depositAmountVnd,
          status: l.status,
          approvalStatus: l.approvalStatus,
        };
        return send(res, 200, envelope(snapshot));
      }
      m = /^\/internal\/listings\/([^/]+)\/holds$/.exec(path);
      if (m) {
        const l = listings.get(m[1])!;
        if (holdConflict || (l.status !== 'AVAILABLE' && !holdAlwaysOk)) {
          holdConflict = false;
          return fail(res, 409, 'LISTING_NOT_AVAILABLE');
        }
        l.status = 'HELD';
        l.heldBy = String(body.depositId);
        return send(
          res,
          200,
          envelope({
            listingId: l.id,
            depositId: body.depositId,
            status: 'HELD',
            heldUntil: body.heldUntil,
          }),
        );
      }
      m = /^\/internal\/listings\/([^/]+)\/status$/.exec(path);
      if (m) {
        const l = listings.get(m[1])!;
        l.status = String(body.status);
        return send(
          res,
          200,
          envelope({ listingId: l.id, depositId: body.depositId, status: l.status }),
        );
      }
      if (path === '/internal/payment-orders' && req.method === 'POST') {
        if (paymentFailTimes > 0) {
          paymentFailTimes -= 1;
          const status = paymentFailStatus;
          return fail(
            res,
            status,
            status === 504 ? 'UPSTREAM_TIMEOUT' : 'PAYMENT_PROVIDER_UNAVAILABLE',
          );
        }
        return send(
          res,
          201,
          envelope({
            orderId: randomUUID(),
            payosOrderCode: 100000 + calls.length,
            checkoutUrl: `https://pay.payos.vn/web/${String(body.depositId)}`,
            qrCode: '00020101021238570010A000000727',
            expiresAt: body.expiresAt,
          }),
        );
      }
      return fail(res, 404, 'NOT_FOUND');
    })().catch(() => {
      if (!res.headersSent) res.writeHead(500).end();
    });
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
  /** Sự kiện trong outbox (relay tắt nên còn nguyên). */
  const outboxEvents = async (eventType: string, key: string, value: string) =>
    (
      await pg.query(
        `SELECT envelope FROM outbox_events WHERE event_type = $1 AND envelope->'payload'->>$2 = $3`,
        [eventType, key, value],
      )
    ).rows.map((r: { envelope: DomainEvent<Record<string, unknown>> }) => r.envelope);
  const viewing = async (id: string) =>
    (await pg.query(`SELECT * FROM viewings WHERE id = $1`, [id])).rows[0];

  async function countQueries(call: () => Promise<unknown>): Promise<number> {
    queries.length = 0;
    await call();
    return queries.filter((q) => !/^(START TRANSACTION|COMMIT|ROLLBACK)/i.test(q.trim())).length;
  }

  const startDeposit = (tenant: { token: string }, listingId: string, key = randomUUID()) =>
    as(tenant.token).post('/api/v1/deposits', { listingId }, { 'Idempotency-Key': key });

  /** Phát `payment.deposited` lên RabbitMQ thật như payment (T3.4) sẽ phát. */
  function publishDeposited(
    d: { id: string; tenant_id: string; owner_id: string },
    eventId: string = randomUUID(),
  ) {
    const paidAt = new Date().toISOString();
    const event: DomainEvent<Record<string, unknown>> = {
      eventId,
      eventType: 'payment.deposited',
      version: 1,
      occurredAt: paidAt,
      correlationId: randomUUID(),
      producer: 'payment',
      payload: {
        depositId: d.id,
        orderId: randomUUID(),
        tenantId: d.tenant_id,
        ownerId: d.owner_id,
        amountVnd: 3_000_000,
        payosReference: `FT${Date.now()}`,
        paidAt,
      },
    };
    expectEventMatchesContract(event);
    channel.publish(EXCHANGE, event.eventType, Buffer.from(JSON.stringify(event)), {
      persistent: true,
      contentType: 'application/json',
    });
    return event;
  }
  async function waitFor<T>(
    fn: () => Promise<T | undefined | null | false>,
    ms = 8000,
  ): Promise<T> {
    const until = Date.now() + ms;
    for (;;) {
      const v = await fn();
      if (v) return v;
      if (Date.now() > until) throw new Error('hết giờ chờ');
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  const processed = async (eventId: string) =>
    (await pg.query(`SELECT 1 FROM processed_events WHERE event_id = $1`, [eventId])).rowCount ===
    1;

  beforeAll(async () => {
    upstream = createServer(handle);
    await new Promise<void>((r) => upstream.listen(0, '127.0.0.1', r));
    const { port } = upstream.address() as AddressInfo;

    pg = new Client({ connectionString: process.env.DATABASE_URL });
    await pg.connect();
    await pg.query(`DROP SCHEMA IF EXISTS ${INFRA_TEST_SCHEMA} CASCADE`);
    await pg.query(`CREATE SCHEMA ${INFRA_TEST_SCHEMA}`);

    amqp = await amqplib.connect(process.env.RABBITMQ_URL as string);
    channel = await amqp.createChannel();
    await channel.assertQueue(DLQ, { durable: false });
    await channel.bindQueue(DLQ, DLX, QUEUE);
    await channel.assertQueue(QUEUE, {
      durable: false,
      arguments: { 'x-dead-letter-exchange': DLX, 'x-dead-letter-routing-key': QUEUE },
    });
    await channel.bindQueue(QUEUE, EXCHANGE, 'payment.deposited');

    const root = readRootEnv();
    Object.assign(process.env, {
      // producer của sự kiện phải là `rental` (envelope trong contracts/events)
      SERVICE_NAME: 'rental',
      REDIS_URL: `redis://:${encodeURIComponent(root.REDIS_PASSWORD as string)}@localhost:${root.REDIS_PORT ?? '6379'}`,
      JWT_PUBLIC_KEY: publicKey,
      JWT_ISSUER: ISSUER,
      INTERNAL_LISTING_URL: `http://127.0.0.1:${port}`,
      INTERNAL_PAYMENT_URL: `http://127.0.0.1:${port}`,
      RABBITMQ_QUEUE: QUEUE,
      OUTBOX_RELAY_ENABLED: 'false',
      HOLD_TTL_SECONDS: String(HOLD_TTL_SECONDS),
      RABBITMQ_MAX_RETRIES: '1',
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
    owner.token = sign(owner.id, 'LANDLORD');
    otherOwner.token = sign(otherOwner.id, 'LANDLORD');
    for (const tn of tenants) tn.token = sign(tn.id, 'TENANT');
  });

  afterAll(async () => {
    await t?.app.close();
    await channel?.deleteQueue(QUEUE).catch(() => undefined);
    await channel?.deleteQueue(DLQ).catch(() => undefined);
    await amqp?.close().catch(() => undefined);
    await pg?.query(`DROP SCHEMA IF EXISTS ${INFRA_TEST_SCHEMA} CASCADE`).catch(() => undefined);
    await pg?.end();
    await new Promise((r) => upstream?.close(r));
    for (const name of ENV_NAMES) delete process.env[name];
    process.env.SERVICE_NAME = 'template-nest-test';
  });

  beforeEach(() => {
    paymentFailTimes = 0;
    holdAlwaysOk = false;
    holdConflict = false;
  });

  describe('POST /deposits (RE.DEPOSIT_SAGA)', () => {
    it('test 1: mọi bước thành công -> 201 PENDING_PAYMENT; saga_log 2 dòng OK; một rental.deposit-created khớp contract', async () => {
      const l = newListing();
      const res = await startDeposit(tenants[0], l.id);

      expect(res.status).toBe(201);
      const data = res.body.data;
      expect(data).toMatchObject({
        status: 'PENDING_PAYMENT',
        listingId: l.id,
        amountVnd: 3_000_000,
      });
      expect(data.checkoutUrl).toBe(`https://pay.payos.vn/web/${data.depositId}`);
      expect(data.holdRemainingSeconds).toBeGreaterThan(HOLD_TTL_SECONDS - 10);
      const d = await deposit(data.depositId);
      expect(d).toMatchObject({
        status: 'PENDING_PAYMENT',
        listing_id: l.id,
        tenant_id: tenants[0].id,
      });
      expect(d.payment_order_id).not.toBeNull();
      expect(await sagaLog(data.depositId)).toEqual([
        { step: 'HOLD_LISTING', outcome: 'OK', detail: null },
        { step: 'CREATE_PAYMENT_ORDER', outcome: 'OK', detail: null },
      ]);
      const events = await outboxEvents('rental.deposit-created', 'depositId', data.depositId);
      expect(events).toHaveLength(1);
      expectEventMatchesContract(events[0]);
      // listing giả nhận đúng depositId, hạn giữ chỗ = expiresAt của đơn
      const hold = calls.find((c) => c.path === `/internal/listings/${l.id}/holds`)!;
      expect(hold.body).toEqual({ depositId: data.depositId, heldUntil: data.expiresAt });
    });

    it('test 2: số tiền, chủ tin, tiêu đề lấy từ bản chụp listing (BR-04); body có amountVnd bị từ chối', async () => {
      const l = newListing({ depositAmountVnd: 4_500_000, title: 'Căn hộ mini' });
      const bad = await as(tenants[0].token).post(
        '/api/v1/deposits',
        { listingId: l.id, amountVnd: 1 },
        { 'Idempotency-Key': randomUUID() },
      );
      expect(bad.status).toBe(400);

      const res = await startDeposit(tenants[0], l.id);
      const d = await deposit(res.body.data.depositId);
      expect(d).toMatchObject({
        amount_vnd: '4500000',
        owner_id: owner.id,
        listing_title: 'Căn hộ mini',
      });
      const order = calls.filter((c) => c.path === '/internal/payment-orders').at(-1)!;
      expect(order.body).toMatchObject({
        amountVnd: 4_500_000,
        ownerId: owner.id,
        listingTitle: 'Căn hộ mini',
      });
    });

    it('test 9: cùng Idempotency-Key hai lần -> một đơn; lần hai trả lại response cũ', async () => {
      const l = newListing();
      const key = randomUUID();
      const first = await startDeposit(tenants[1], l.id, key);
      const second = await startDeposit(tenants[1], l.id, key);

      expect(first.status).toBe(201);
      expect(second.status).toBe(201);
      expect(second.headers['idempotent-replayed']).toBe('true');
      expect(second.body.data).toEqual(first.body.data);
      const n = await pg.query(`SELECT count(*) FROM deposits WHERE listing_id = $1`, [l.id]);
      expect(n.rows[0].count).toBe('1');
    });

    it('test 18: unique ux_deposits_active_listing chặn đơn hoạt động thứ hai trên cùng tin (lớp chặn 3)', async () => {
      const l = newListing();
      const first = await startDeposit(tenants[0], l.id);
      expect(first.status).toBe(201);
      // DB trực tiếp: đơn hoạt động thứ hai bị chặn
      await expect(
        pg.query(
          `INSERT INTO deposits (id, listing_id, tenant_id, owner_id, listing_title, amount_vnd, status, expires_at)
           VALUES ($1, $2, $3, $4, 'x', 1, 'PAID', now())`,
          [randomUUID(), l.id, tenants[2].id, owner.id],
        ),
      ).rejects.toThrow(/ux_deposits_active_listing/);
      // Qua API, khi listing lệch (bản chụp lại AVAILABLE, vẫn cho giữ chỗ): 409 LISTING_NOT_AVAILABLE, nhả chỗ
      l.status = 'AVAILABLE';
      holdAlwaysOk = true;
      const second = await startDeposit(tenants[2], l.id);
      expect(second.status).toBe(409);
      expect(second.body.error.code).toBe('LISTING_NOT_AVAILABLE');
      const release = calls.filter((c) => c.path === `/internal/listings/${l.id}/status`).at(-1)!;
      expect(release.body.status).toBe('AVAILABLE');
      expect(release.body.depositId).not.toBe(first.body.data.depositId);
      const n = await pg.query(`SELECT count(*) FROM deposits WHERE listing_id = $1`, [l.id]);
      expect(n.rows[0].count).toBe('1');
    });

    it('giữ chỗ 409 (người khác vừa giữ, bản chụp còn AVAILABLE) -> 409 LISTING_NOT_AVAILABLE, không có đơn (Báo cáo T06)', async () => {
      const l = newListing();
      holdConflict = true;
      const res = await startDeposit(tenants[0], l.id);
      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe('LISTING_NOT_AVAILABLE');
      const n = await pg.query(`SELECT count(*) FROM deposits WHERE listing_id = $1`, [l.id]);
      expect(n.rows[0].count).toBe('0');
      expect(
        calls.some(
          (c) =>
            c.path === '/internal/payment-orders' &&
            c.body.listingTitle === l.title &&
            c.body.depositId === undefined,
        ),
      ).toBe(false);
    });

    it('tin chưa duyệt -> 409 LISTING_NOT_AVAILABLE; tin không có -> 404 LISTING_NOT_FOUND (chuyển nguyên)', async () => {
      const l = newListing({ approvalStatus: 'PENDING_REVIEW' });
      const res = await startDeposit(tenants[0], l.id);
      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe('LISTING_NOT_AVAILABLE');
      const missing = await startDeposit(tenants[0], randomUUID());
      expect(missing.status).toBe(404);
      expect(missing.body.error.code).toBe('LISTING_NOT_FOUND');
    });

    it('tạo order 504 -> 504, đơn giữ PENDING_PAYMENT, saga_log CREATE_PAYMENT_ORDER UNKNOWN (bù trừ: T3.3)', async () => {
      const l = newListing();
      paymentFailStatus = 504;
      paymentFailTimes = 3; // lần đầu + 2 lần retry của InternalHttpService (POST idempotent)
      const res = await startDeposit(tenants[3], l.id);
      expect(res.status).toBe(504);
      const d = (await pg.query(`SELECT * FROM deposits WHERE listing_id = $1`, [l.id])).rows[0];
      expect(d.status).toBe('PENDING_PAYMENT');
      expect((await sagaLog(d.id)).map((r: { outcome: string }) => r.outcome)).toEqual([
        'OK',
        'UNKNOWN',
      ]);
    });

    it('chỉ TENANT; thiếu Idempotency-Key -> 400', async () => {
      const l = newListing();
      expect(
        (
          await as(owner.token).post(
            '/api/v1/deposits',
            { listingId: l.id },
            { 'Idempotency-Key': randomUUID() },
          )
        ).status,
      ).toBe(403);
      expect(
        (await as(tenants[0].token).post('/api/v1/deposits', { listingId: l.id })).status,
      ).toBe(400);
    });

    it('số truy vấn POST /deposits: 5 (đơn, saga_log, outbox; lưu order, saga_log) ≤ ngưỡng ghi 6', async () => {
      const l = newListing();
      let status = 0;
      expect(
        await countQueries(async () => {
          status = (await startDeposit(tenants[0], l.id)).status;
        }),
      ).toBe(5);
      expect(status).toBe(201);
    });
  });

  describe('payment.deposited qua RabbitMQ thật (test 14, 15; RE.VIEWING test 7, 8)', () => {
    it('test 14 + viewing 7: PAID, mốc 48h/72h, đích DEPOSITED; 2 yêu cầu REQUESTED của người khác -> CANCELLED LISTING_DEPOSITED, 2 sự kiện', async () => {
      const l = newListing();
      const [payer, a, b, c] = tenants;
      const v = async (tn: { token: string }) =>
        (await as(tn.token).post('/api/v1/viewings', { listingId: l.id })).body.data.id as string;
      const payerViewing = await v(payer);
      const va = await v(a);
      const vb = await v(b);
      const vc = await v(c);
      expect((await as(c.token).post(`/api/v1/viewings/${vc}/confirm-viewed`)).status).toBe(200);

      const created = await startDeposit(payer, l.id);
      const d = await deposit(created.body.data.depositId);
      const event = publishDeposited(d);
      await waitFor(() => processed(event.eventId));

      const after = await deposit(d.id);
      expect(after.status).toBe('PAID');
      const paidAt = new Date(event.payload.paidAt as string).getTime();
      expect(new Date(after.paid_at).getTime()).toBe(paidAt);
      expect(new Date(after.refund_deadline_at).getTime() - paidAt).toBe(172800 * 1000);
      expect(new Date(after.auto_release_at).getTime() - paidAt).toBe(259200 * 1000);
      expect(after).toMatchObject({ listing_target_status: 'DEPOSITED', listing_synced_at: null });

      expect((await viewing(va)).status).toBe('CANCELLED');
      expect((await viewing(va)).cancel_reason).toBe('LISTING_DEPOSITED');
      expect((await viewing(vb)).status).toBe('CANCELLED');
      expect((await viewing(payerViewing)).status).toBe('REQUESTED'); // của người cọc
      expect((await viewing(vc)).status).toBe('CONFIRMED');
      const cancelled = await outboxEvents('rental.viewing-cancelled', 'listingId', l.id);
      expect(cancelled).toHaveLength(2);
      for (const e of cancelled) {
        expectEventMatchesContract(e);
        expect(e.payload.reason).toBe('LISTING_DEPOSITED');
      }

      // test 15 + viewing 8: giao lại CÙNG eventId -> bỏ qua; eventId KHÁC cho đơn đã PAID -> UPDATE 0 dòng
      publishDeposited(d, event.eventId);
      const again = publishDeposited(d);
      await waitFor(() => processed(again.eventId));
      expect(await outboxEvents('rental.viewing-cancelled', 'listingId', l.id)).toHaveLength(2);
      expect((await deposit(d.id)).paid_at).toEqual(after.paid_at);
    });

    it('test 16: payment.deposited cho đơn không còn PENDING_PAYMENT (EXPIRED) -> không đổi', async () => {
      const l = newListing();
      const created = await startDeposit(tenants[1], l.id);
      await pg.query(`UPDATE deposits SET status = 'EXPIRED' WHERE id = $1`, [
        created.body.data.depositId,
      ]);
      const d = await deposit(created.body.data.depositId);
      const event = publishDeposited(d);
      await waitFor(() => processed(event.eventId));
      expect((await deposit(d.id)).status).toBe('EXPIRED');
    });
  });

  describe('lịch xem (RE.VIEWING §1)', () => {
    const post = (tn: { token: string }, path: string, body?: object) =>
      as(tn.token).post(path, body);

    it('route 1: 201 REQUESTED, bản chụp chủ tin; rental.viewing-requested khớp contract (viewing test 9)', async () => {
      const l = newListing();
      const res = await post(tenants[0], '/api/v1/viewings', {
        listingId: l.id,
        note: '  cuối tuần ',
      });
      expect(res.status).toBe(201);
      expect(res.body.data).toMatchObject({
        listingId: l.id,
        ownerId: owner.id,
        tenantId: tenants[0].id,
        status: 'REQUESTED',
        note: 'cuối tuần',
        listingTitle: l.title,
      });
      const [e] = await outboxEvents('rental.viewing-requested', 'viewingId', res.body.data.id);
      expectEventMatchesContract(e);
    });

    it('viewing test 1: tin chưa duyệt -> 404 LISTING_NOT_FOUND; chủ tin tự đặt -> 403', async () => {
      const l = newListing({ approvalStatus: 'PENDING_REVIEW' });
      const res = await post(tenants[0], '/api/v1/viewings', { listingId: l.id });
      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe('LISTING_NOT_FOUND');
      const own = newListing({ ownerId: tenants[3].id });
      const self = await post(tenants[3], '/api/v1/viewings', { listingId: own.id });
      expect(self.status).toBe(403);
      expect(self.body.error.code).toBe('RENTAL_VIEWING_OWN_LISTING');
    });

    it('viewing test 2, 3: trùng khi còn REQUESTED -> 409; sau CANCELLED/DECLINED/CONFIRMED đặt lại -> 201', async () => {
      const l = newListing();
      const first = await post(tenants[0], '/api/v1/viewings', { listingId: l.id });
      const dup = await post(tenants[0], '/api/v1/viewings', { listingId: l.id });
      expect(dup.status).toBe(409);
      expect(dup.body.error.code).toBe('RENTAL_VIEWING_DUPLICATE');

      await post(tenants[0], `/api/v1/viewings/${first.body.data.id}/cancel`);
      const second = await post(tenants[0], '/api/v1/viewings', { listingId: l.id });
      expect(second.status).toBe(201);
      await post(owner, `/api/v1/viewings/${second.body.data.id}/respond`, { decision: 'DECLINE' });
      const third = await post(tenants[0], '/api/v1/viewings', { listingId: l.id });
      expect(third.status).toBe(201);
      await post(tenants[0], `/api/v1/viewings/${third.body.data.id}/confirm-viewed`);
      expect((await post(tenants[0], '/api/v1/viewings', { listingId: l.id })).status).toBe(201);
    });

    it('viewing test 4, 5, 6: chủ trọ khác từ chối -> 403; xác nhận đã xem -> 200 CONFIRMED; hủy khi đã CONFIRMED -> 409', async () => {
      const l = newListing();
      const id = (await post(tenants[1], '/api/v1/viewings', { listingId: l.id })).body.data.id;
      const other = await post(otherOwner, `/api/v1/viewings/${id}/respond`, {
        decision: 'DECLINE',
      });
      expect(other.status).toBe(403);
      expect((await viewing(id)).status).toBe('REQUESTED');

      const ok = await post(tenants[1], `/api/v1/viewings/${id}/confirm-viewed`);
      expect(ok.status).toBe(200);
      expect(ok.body.data.status).toBe('CONFIRMED');
      const [confirmed] = await outboxEvents('rental.viewing-confirmed', 'viewingId', id);
      expectEventMatchesContract(confirmed);

      const late = await post(tenants[1], `/api/v1/viewings/${id}/cancel`);
      expect(late.status).toBe(409);
      expect(late.body.error.code).toBe('RENTAL_INVALID_TRANSITION');
      expect((await post(tenants[1], `/api/v1/viewings/${randomUUID()}/cancel`)).status).toBe(404);
    });

    it('viewing test 9: từ chối và hủy ghi đúng một sự kiện, khớp contract', async () => {
      const l = newListing();
      const a = (await post(tenants[2], '/api/v1/viewings', { listingId: l.id })).body.data.id;
      expect(
        (await post(owner, `/api/v1/viewings/${a}/respond`, { decision: 'DECLINE' })).status,
      ).toBe(200);
      const responded = await outboxEvents('rental.viewing-responded', 'viewingId', a);
      expect(responded).toHaveLength(1);
      expectEventMatchesContract(responded[0]);
      expect(responded[0].payload.decision).toBe('DECLINED');

      const b = (await post(tenants[2], '/api/v1/viewings', { listingId: l.id })).body.data.id;
      await post(tenants[2], `/api/v1/viewings/${b}/cancel`);
      const cancelled = await outboxEvents('rental.viewing-cancelled', 'viewingId', b);
      expect(cancelled).toHaveLength(1);
      expectEventMatchesContract(cancelled[0]);
      expect(cancelled[0].payload.reason).toBe('TENANT');
    });

    it('viewing test 10: danh sách của tôi chỉ lịch liên quan người gọi; chủ trọ lọc theo listingId; 2 truy vấn', async () => {
      const l1 = newListing({ ownerId: otherOwner.id });
      const l2 = newListing({ ownerId: otherOwner.id });
      await post(tenants[3], '/api/v1/viewings', { listingId: l1.id });
      await post(tenants[3], '/api/v1/viewings', { listingId: l2.id });
      await post(tenants[2], '/api/v1/viewings', { listingId: l1.id });

      const mine = await as(tenants[3].token).get('/api/v1/viewings/mine?pageSize=50');
      expect(mine.status).toBe(200);
      expect(mine.body.data.every((x: { tenantId: string }) => x.tenantId === tenants[3].id)).toBe(
        true,
      );

      let filtered!: Awaited<ReturnType<ReturnType<typeof as>['get']>>;
      expect(
        await countQueries(async () => {
          filtered = await as(otherOwner.token).get(`/api/v1/viewings/mine?listingId=${l1.id}`);
        }),
      ).toBeLessThanOrEqual(2);
      expect(filtered.body.data).toHaveLength(2);
      expect(filtered.body.meta.total).toBe(2);
      expect(
        filtered.body.data.every(
          (x: { listingId: string; ownerId: string }) =>
            x.listingId === l1.id && x.ownerId === otherOwner.id,
        ),
      ).toBe(true);
    });

    it('số truy vấn: đặt lịch 2 (INSERT, outbox); hủy 2 (UPDATE, outbox) ≤ ngưỡng ghi 6', async () => {
      const l = newListing();
      let id = '';
      expect(
        await countQueries(async () => {
          id = (await post(tenants[1], '/api/v1/viewings', { listingId: l.id })).body.data.id;
        }),
      ).toBe(2);
      expect(await countQueries(() => post(tenants[1], `/api/v1/viewings/${id}/cancel`))).toBe(2);
    });
  });
});
