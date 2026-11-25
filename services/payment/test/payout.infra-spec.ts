import { JwtService } from '@nestjs/jwt';
import { generateKeyPairSync, randomUUID } from 'node:crypto';
import { createServer, IncomingMessage, Server, ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Client } from 'pg';
import { DataSource } from 'typeorm';
import type { DomainEvent } from '../src/messaging/domain-event';
import { ReceiptService } from '../src/payment/services/receipt.service';
import { WalletService } from '../src/payment/services/wallet.service';
import { expectEventMatchesContract, expectResponseMatchesOpenApi } from './helpers/contracts';
import type { TestApp } from './helpers/create-test-app';
import { INFRA_TEST_SCHEMA, readRootEnv } from './helpers/infra';

/**
 * T3.6 payout (`RE.PAYOUT`) với Postgres + Redis THẬT; rental và identity là máy chủ HTTP GIẢ; S3 là bộ nhớ giả
 * (`ReceiptService` thật với `putObject` giả: kiểm loại, byte đầu, cỡ, `sha256` vẫn chạy thật). Đường S3 thật đã
 * kiểm ở `storage.infra-spec.ts` và kiểm chứng compose trên máy A (`current-task.md` mục F).
 *
 * DoD: test 2–17 của `Component_Class_Design §4` (test 1 là unit `refund-amount.spec.ts`); test 13 (E10) sau MỖI
 * test; số truy vấn mỗi route; sự kiện khớp `contracts/events`; route nội bộ khớp `payment-internal.v1.yaml`.
 */
const { privateKey, publicKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});
const ISSUER = 'realestate-identity-test';
const MAX_BYTES = 4096;
const ENV_NAMES = [
  'REDIS_URL',
  'JWT_PUBLIC_KEY',
  'JWT_ISSUER',
  'INTERNAL_RENTAL_URL',
  'INTERNAL_IDENTITY_URL',
  'OUTBOX_RELAY_ENABLED',
  'RECEIPT_MAX_BYTES',
];

const envelope = (data: unknown) => ({
  data,
  meta: { correlationId: 'fake', timestamp: new Date().toISOString() },
});
const PNG_HEAD = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
/** Mỗi lần gọi một tệp PNG khác nội dung (sha256 khác). */
const png = (tag: string = randomUUID()) => Buffer.concat([PNG_HEAD, Buffer.from(tag)]);

interface Eligibility {
  depositId: string;
  ownerId: string;
  amountVnd: number;
  status: string;
  eligible: boolean;
  missing: string[];
}

describe('T3.6 payout (hạ tầng thật, rental/identity giả, S3 giả)', () => {
  let t: TestApp;
  let pg: Client;
  let ds: DataSource;
  let rentalSrv: Server;
  let identitySrv: Server;
  const queries: string[] = [];
  const s3 = new Map<string, Buffer>();
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
    admin2: { id: randomUUID(), role: 'ADMIN', token: '' },
  };

  /** Rental giả: điều kiện rút theo đơn; không có → 404 RENTAL_DEPOSIT_NOT_FOUND. */
  const eligibility = new Map<string, Eligibility>();
  /** Identity giả: tài khoản theo người dùng; không có → 404 IDENTITY_BANK_ACCOUNT_NOT_FOUND. */
  const banks = new Map<
    string,
    { bankName: string; accountHolder: string; accountNumber: string }
  >();

  const json = (res: ServerResponse, status: number, body: unknown) => {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(body));
  };
  const rentalHandler = (req: IncomingMessage, res: ServerResponse) => {
    const m = /^\/internal\/deposits\/([^/]+)\/withdrawal-eligibility$/.exec(req.url ?? '');
    const e = m ? eligibility.get(m[1]) : undefined;
    if (e) return json(res, 200, envelope(e));
    json(res, 404, { error: { code: 'RENTAL_DEPOSIT_NOT_FOUND', message: 'Không tìm thấy đơn' } });
  };
  const identityHandler = (req: IncomingMessage, res: ServerResponse) => {
    const m = /^\/internal\/users\/([^/]+)\/bank-account$/.exec(req.url ?? '');
    const b = m ? banks.get(m[1]) : undefined;
    if (b && m) return json(res, 200, envelope({ userId: m[1], ...b }));
    json(res, 404, {
      error: { code: 'IDENTITY_BANK_ACCOUNT_NOT_FOUND', message: 'Chưa khai tài khoản nhận tiền' },
    });
  };
  const listen = (srv: Server) =>
    new Promise<number>((r) =>
      srv.listen(0, '127.0.0.1', () => r((srv.address() as AddressInfo).port)),
    );

  // ---------- Dữ liệu ----------

  /** Một đơn đã thanh toán: order `PAID` + `DEPOSIT_IN` + số dư tăng (như webhook T3.4a). */
  async function paidDeposit(
    amountVnd = 3_000_000,
    tenantId = users.tenantA.id,
    ownerId = users.owner.id,
  ) {
    const depositId = randomUUID();
    const { rows } = await pg.query(
      `INSERT INTO payment_orders (deposit_id, tenant_id, owner_id, listing_title, amount_vnd, payos_order_code,
         expires_at, status, paid_at, payos_reference)
       VALUES ($1, $2, $3, 'Phòng test', $4, nextval('payos_order_code_seq'), now(), 'PAID', now(), $5)
       RETURNING id`,
      [depositId, tenantId, ownerId, amountVnd, `FT${randomUUID()}`],
    );
    await pg.query(
      `INSERT INTO wallet_transactions (type, amount_vnd, deposit_id, ref_type, ref_id, tenant_id, owner_id)
       VALUES ('DEPOSIT_IN', $1, $2, 'ORDER', $3, $4, $5)`,
      [amountVnd, depositId, rows[0].id, tenantId, ownerId],
    );
    await pg.query(`UPDATE admin_wallet SET balance_vnd = balance_vnd + $1 WHERE id = 1`, [
      amountVnd,
    ]);
    return { depositId, orderId: rows[0].id as string, tenantId, ownerId, amountVnd };
  }

  /** Tiền đến muộn (như `recordLate` T3.4a): `LATE_PAYMENT_IN` + yêu cầu hoàn `SYSTEM` 100%. */
  async function latePayment(amountVnd = 2_000) {
    const d = await paidDeposit(amountVnd);
    const { rows } = await pg.query(
      `INSERT INTO refund_requests (deposit_id, tenant_id, requester_type, amount_vnd)
       VALUES ($1, $2, 'SYSTEM', $3) RETURNING id`,
      [d.depositId, d.tenantId, amountVnd],
    );
    await pg.query(
      `INSERT INTO wallet_transactions (type, amount_vnd, deposit_id, ref_type, ref_id, tenant_id)
       VALUES ('LATE_PAYMENT_IN', $1, $2, 'LATE_PAYMENT', $3, $4)`,
      [amountVnd, d.depositId, randomUUID(), d.tenantId],
    );
    await pg.query(`UPDATE admin_wallet SET balance_vnd = balance_vnd + $1 WHERE id = 1`, [
      amountVnd,
    ]);
    return { ...d, refundId: rows[0].id as string };
  }

  const released = (
    d: { depositId: string; ownerId: string; amountVnd: number },
    over: Partial<Eligibility> = {},
  ) =>
    eligibility.set(d.depositId, {
      depositId: d.depositId,
      ownerId: d.ownerId,
      amountVnd: d.amountVnd,
      status: 'RELEASED',
      eligible: true,
      missing: [],
      ...over,
    });

  // ---------- HTTP ----------

  const as = (u: { token: string }) => ({
    get: (path: string) => t.http().get(path).set('Authorization', `Bearer ${u.token}`),
    post: (path: string, body?: object, key: string | null = randomUUID()) => {
      const r = t.http().post(path).set('Authorization', `Bearer ${u.token}`);
      if (key) r.set('Idempotency-Key', key);
      return body ? r.send(body) : r;
    },
    upload: (path: string, file: Buffer, opts: { key?: string | null; mime?: string } = {}) => {
      const r = t.http().post(path).set('Authorization', `Bearer ${u.token}`);
      if (opts.key !== null) r.set('Idempotency-Key', opts.key ?? randomUUID());
      return r.attach('receipt', file, {
        filename: 'ct.png',
        contentType: opts.mime ?? 'image/png',
      });
    },
  });
  const internalRefund = (depositId: string) =>
    t.http().post('/internal/refund-requests').send({ depositId });

  // ---------- Đọc DB ----------

  const balance = async () =>
    Number(
      (await pg.query(`SELECT balance_vnd FROM admin_wallet WHERE id = 1`)).rows[0].balance_vnd,
    );
  const outbox = async (eventType: string, key: string, value: string) =>
    (
      await pg.query(
        `SELECT envelope FROM outbox_events WHERE event_type = $1 AND envelope->'payload'->>'${key}' = $2`,
        [eventType, value],
      )
    ).rows.map((r) => r.envelope as DomainEvent<Record<string, unknown>>);
  const audits = async (targetId: string) =>
    (await pg.query(`SELECT * FROM audit_log WHERE target_id = $1 ORDER BY id`, [targetId])).rows;
  const depositNet = async (depositId: string) =>
    Number(
      (
        await pg.query(
          `SELECT COALESCE(SUM(CASE WHEN type IN ('DEPOSIT_IN','LATE_PAYMENT_IN') THEN amount_vnd ELSE -amount_vnd END), 0) AS net
           FROM wallet_transactions WHERE deposit_id = $1`,
          [depositId],
        )
      ).rows[0].net,
    );

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

  beforeAll(async () => {
    rentalSrv = createServer(rentalHandler);
    identitySrv = createServer(identityHandler);
    const rentalPort = await listen(rentalSrv);
    const identityPort = await listen(identitySrv);

    pg = new Client({ connectionString: process.env.DATABASE_URL });
    await pg.connect();
    await pg.query(`DROP SCHEMA IF EXISTS ${INFRA_TEST_SCHEMA} CASCADE`);
    await pg.query(`CREATE SCHEMA ${INFRA_TEST_SCHEMA}`);

    const root = readRootEnv();
    Object.assign(process.env, {
      SERVICE_NAME: 'payment', // producer của sự kiện phải là "payment" (contracts/events)
      REDIS_URL: `redis://:${encodeURIComponent(root.REDIS_PASSWORD as string)}@localhost:${root.REDIS_PORT ?? '6379'}`,
      JWT_PUBLIC_KEY: publicKey,
      JWT_ISSUER: ISSUER,
      INTERNAL_RENTAL_URL: `http://127.0.0.1:${rentalPort}`,
      INTERNAL_IDENTITY_URL: `http://127.0.0.1:${identityPort}`,
      OUTBOX_RELAY_ENABLED: 'false',
      RECEIPT_MAX_BYTES: String(MAX_BYTES),
    });
    const fakeStorage = {
      putObject: async (_bucket: string, key: string, body: Buffer) => {
        s3.set(key, body);
      },
    };
    const { createTestApp } = await import('./helpers/create-test-app');
    t = await createTestApp([], [], {
      overrides: [
        { provide: ReceiptService, useValue: new ReceiptService(fakeStorage, MAX_BYTES) },
      ],
    });
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
    banks.set(users.owner.id, {
      bankName: 'Vietcombank',
      accountHolder: 'CHU TRO',
      accountNumber: '0011223344',
    });
    banks.set(users.tenantA.id, {
      bankName: 'MB',
      accountHolder: 'NGUOI THUE A',
      accountNumber: '9988776655',
    });
  });

  afterAll(async () => {
    await t?.app.close();
    await pg?.query(`DROP SCHEMA IF EXISTS ${INFRA_TEST_SCHEMA} CASCADE`).catch(() => undefined);
    await pg?.end();
    for (const srv of [rentalSrv, identitySrv]) {
      srv?.closeAllConnections();
      await new Promise((r) => (srv?.listening ? srv.close(r) : r(undefined)));
    }
    for (const name of ENV_NAMES) delete process.env[name];
    process.env.SERVICE_NAME = 'template-nest-test';
  });

  // Test 13 (E10): sau MỖI test, số dư ví = tổng vào − tổng ra (dùng chính WalletService.invariant)
  afterEach(async () => {
    if (!t) return; // beforeAll lỗi (hạ tầng chưa chạy): lỗi gốc đã được báo, không báo thêm lỗi phụ
    const inv = await t.app.get(WalletService).invariant(ds.manager);
    expect(inv).toMatchObject({ holds: true });
    expect(inv.balanceVnd).toBeGreaterThanOrEqual(0);
  });

  // ======================================================================================
  describe('API nội bộ POST /internal/refund-requests (§2)', () => {
    it('201 tạo 70% PENDING_ADMIN khớp hợp đồng; gọi lại 200 cùng yêu cầu (test 2); ≤ 3 truy vấn', async () => {
      const d = await paidDeposit(3_000_001);
      const { n, result: first } = await countQueries(() => internalRefund(d.depositId));
      expect(first.status).toBe(201);
      expect(first.body.data).toMatchObject({
        depositId: d.depositId,
        amountVnd: 2_100_000, // floor
        requesterType: 'TENANT',
        status: 'PENDING_ADMIN',
      });
      expectResponseMatchesOpenApi(
        'payment-internal.v1.yaml',
        'POST',
        '/internal/refund-requests',
        201,
        first.body,
      );
      expect(n).toBeLessThanOrEqual(3);

      const again = await internalRefund(d.depositId);
      expect(again.status).toBe(200);
      expect(again.body.data.refundRequestId).toBe(first.body.data.refundRequestId);
      expectResponseMatchesOpenApi(
        'payment-internal.v1.yaml',
        'POST',
        '/internal/refund-requests',
        200,
        again.body,
      );
      const { rows } = await pg.query(
        `SELECT count(*) FROM refund_requests WHERE deposit_id = $1`,
        [d.depositId],
      );
      expect(Number(rows[0].count)).toBe(1);
    });

    it('không có order → 404 PAYMENT_ORDER_NOT_FOUND; order chưa PAID → 409 PAYMENT_ORDER_NOT_PAID (khớp hợp đồng)', async () => {
      const r404 = await internalRefund(randomUUID());
      expect([r404.status, r404.body.error.code]).toEqual([404, 'PAYMENT_ORDER_NOT_FOUND']);
      const depositId = randomUUID();
      await pg.query(
        `INSERT INTO payment_orders (deposit_id, tenant_id, owner_id, amount_vnd, payos_order_code, expires_at)
         VALUES ($1, $2, $3, 1000, nextval('payos_order_code_seq'), now())`,
        [depositId, randomUUID(), randomUUID()],
      );
      const r409 = await internalRefund(depositId);
      expect([r409.status, r409.body.error.code]).toEqual([409, 'PAYMENT_ORDER_NOT_PAID']);
      expectResponseMatchesOpenApi(
        'payment-internal.v1.yaml',
        'POST',
        '/internal/refund-requests',
        409,
        r409.body,
      );
    });

    it('hai lời gọi đồng thời → một yêu cầu (ux_refund_tenant_active)', async () => {
      const d = await paidDeposit();
      const [a, b] = await Promise.all([internalRefund(d.depositId), internalRefund(d.depositId)]);
      expect([a.status, b.status].sort()).toEqual([200, 201]);
      expect(a.body.data.refundRequestId).toBe(b.body.data.refundRequestId);
    });
  });

  // ======================================================================================
  describe('Hoàn tiền: route 5, 8, 9, 10, 14', () => {
    it('test 3 + 14: hoàn tất → COMPLETED, REFUND_OUT, số dư giảm đúng, 1 payment.refunded khớp hợp đồng, 1 audit; 7 truy vấn', async () => {
      const d = await paidDeposit();
      const id = (await internalRefund(d.depositId)).body.data.refundRequestId as string;
      const before = await balance();

      const { n, result: res } = await countQueries(() =>
        as(users.admin).upload(`/api/v1/admin/refund-requests/${id}/complete`, png()),
      );
      expect(res.status).toBe(200);
      expect(res.body.data).toMatchObject({ id, status: 'COMPLETED', processedBy: users.admin.id });
      expect(n).toBe(7); // ngưỡng ghi có tiền 8
      expect(await balance()).toBe(before - 2_100_000);

      const tx = (
        await pg.query(
          `SELECT * FROM wallet_transactions WHERE ref_type = 'REFUND' AND ref_id = $1`,
          [id],
        )
      ).rows;
      expect(tx).toHaveLength(1);
      expect(tx[0]).toMatchObject({
        type: 'REFUND_OUT',
        amount_vnd: '2100000',
        tenant_id: d.tenantId,
        owner_id: d.ownerId,
      });

      const ev = await outbox('payment.refunded', 'refundRequestId', id);
      expect(ev).toHaveLength(1);
      expectEventMatchesContract(ev[0]);
      expect(ev[0].payload).toEqual({
        depositId: d.depositId,
        refundRequestId: id,
        tenantId: d.tenantId,
        ownerId: d.ownerId,
        amountVnd: 2_100_000,
        requesterType: 'TENANT',
      });

      const a = await audits(id);
      expect(a).toHaveLength(1);
      expect(a[0]).toMatchObject({
        actor_id: users.admin.id,
        action: 'COMPLETE_REFUND',
        target_type: 'REFUND',
        before: { status: 'PENDING_ADMIN' },
      });
      const rec = (
        await pg.query(`SELECT * FROM transfer_receipts WHERE id = $1`, [res.body.data.receiptId])
      ).rows[0];
      expect(rec.object_key).toMatch(/^receipts\/[0-9a-f]{64}\.png$/);
      expect(s3.has(rec.object_key)).toBe(true);
    });

    it('test 4 + 14: từ chối → REJECTED, 1 payment.refund-rejected {reason}, ví không đổi, 1 audit; test 17: rental gọi lại → yêu cầu MỚI 201', async () => {
      const d = await paidDeposit();
      const id = (await internalRefund(d.depositId)).body.data.refundRequestId as string;
      const before = await balance();

      const { n, result: res } = await countQueries(() =>
        as(users.admin).post(
          `/api/v1/admin/refund-requests/${id}/reject`,
          { reason: '  Đã nhận phòng  ' },
          null,
        ),
      );
      expect(res.status).toBe(200);
      expect(res.body.data).toMatchObject({ status: 'REJECTED', reason: 'Đã nhận phòng' }); // cắt khoảng trắng
      expect(n).toBe(3);
      expect(await balance()).toBe(before);
      const ev = await outbox('payment.refund-rejected', 'refundRequestId', id);
      expect(ev).toHaveLength(1);
      expectEventMatchesContract(ev[0]);
      expect(ev[0].payload).toMatchObject({ reason: 'Đã nhận phòng', ownerId: d.ownerId });
      expect(await audits(id)).toHaveLength(1);

      const again = await internalRefund(d.depositId);
      expect(again.status).toBe(201);
      expect(again.body.data.refundRequestId).not.toBe(id);
    });

    it('test 5: thất bại (không phát sự kiện, audit) rồi hoàn tất lại → COMPLETED; 2 audit', async () => {
      const d = await paidDeposit();
      const id = (await internalRefund(d.depositId)).body.data.refundRequestId as string;
      const { n, result: failed } = await countQueries(() =>
        as(users.admin).post(
          `/api/v1/admin/refund-requests/${id}/fail`,
          { reason: 'Sai số tài khoản' },
          null,
        ),
      );
      expect(failed.status).toBe(200);
      expect(failed.body.data.status).toBe('FAILED');
      expect(n).toBe(2);
      expect(await outbox('payment.refunded', 'refundRequestId', id)).toHaveLength(0);

      const done = await as(users.admin).upload(
        `/api/v1/admin/refund-requests/${id}/complete`,
        png(),
      );
      expect(done.status).toBe(200);
      expect(done.body.data.status).toBe('COMPLETED');
      expect((await audits(id)).map((a) => a.action)).toEqual(['FAIL_REFUND', 'COMPLETE_REFUND']);
    });

    it('B8: hoàn tất yêu cầu SYSTEM (tiền đến muộn) → REFUND_OUT không gắn chủ trọ; payment.refunded requesterType SYSTEM', async () => {
      const late = await latePayment(2_000);
      const res = await as(users.admin).upload(
        `/api/v1/admin/refund-requests/${late.refundId}/complete`,
        png(),
      );
      expect(res.status).toBe(200);
      const tx = (
        await pg.query(
          `SELECT * FROM wallet_transactions WHERE ref_type = 'REFUND' AND ref_id = $1`,
          [late.refundId],
        )
      ).rows;
      expect(tx[0]).toMatchObject({ type: 'REFUND_OUT', amount_vnd: '2000', owner_id: null });
      const ev = await outbox('payment.refunded', 'refundRequestId', late.refundId);
      expectEventMatchesContract(ev[0]);
      expect(ev[0].payload).toMatchObject({ requesterType: 'SYSTEM', amountVnd: 2_000 });
    });

    it('test 15: route 14 chi tiết: người thuê đã khai → số đầy đủ; chưa khai (tiền đến muộn của người thuê B) → null; 1 truy vấn', async () => {
      const d = await paidDeposit();
      const id = (await internalRefund(d.depositId)).body.data.refundRequestId as string;
      const { n, result: res } = await countQueries(() =>
        as(users.admin).get(`/api/v1/admin/refund-requests/${id}`),
      );
      expect(res.status).toBe(200);
      expect(res.body.data.bankAccount).toEqual({
        bankName: 'MB',
        accountHolder: 'NGUOI THUE A',
        accountNumber: '9988776655',
      });
      expect(n).toBe(1);

      const dB = await paidDeposit(1_000, users.tenantB.id);
      const { rows } = await pg.query(
        `INSERT INTO refund_requests (deposit_id, tenant_id, requester_type, amount_vnd) VALUES ($1, $2, 'SYSTEM', 1000) RETURNING id`,
        [dB.depositId, users.tenantB.id],
      );
      const none = await as(users.admin).get(`/api/v1/admin/refund-requests/${rows[0].id}`);
      expect(none.status).toBe(200);
      expect(none.body.data.bankAccount).toBeNull();
      expect(JSON.stringify(t.logs)).not.toContain('9988776655'); // số đầy đủ không vào log
    });

    it('route 5: lọc status; không có quyền ADMIN → 403', async () => {
      const res = await as(users.admin).get(
        '/api/v1/admin/refund-requests?status=PENDING_ADMIN&pageSize=5',
      );
      expect(res.status).toBe(200);
      expect(res.body.data.every((r: { status: string }) => r.status === 'PENDING_ADMIN')).toBe(
        true,
      );
      expect(res.body.meta).toMatchObject({ page: 1, pageSize: 5 });
      expect((await as(users.owner).get('/api/v1/admin/refund-requests')).status).toBe(403);
    });
  });

  // ======================================================================================
  describe('Rút tiền: route 2, 3, 4, 6, 7, 13', () => {
    it('route 2 + 6 + 14: tạo lệnh rút đơn RELEASED (201, bản chụp che số, 1 withdrawal-requested) rồi hoàn tất (WITHDRAW_OUT, 1 withdrawal-completed); ví về 0 cho đơn', async () => {
      const d = await paidDeposit();
      released(d);
      const { n: nCreate, result: created } = await countQueries(() =>
        as(users.owner).post('/api/v1/withdrawals', { depositId: d.depositId }),
      );
      expect(created.status).toBe(201);
      expect(created.body.data).toMatchObject({
        depositId: d.depositId,
        ownerId: users.owner.id,
        amountVnd: 3_000_000,
        status: 'PENDING',
        bankSnapshot: { bankName: 'Vietcombank', accountHolder: 'CHU TRO', accountLast4: '3344' },
      });
      expect(nCreate).toBeLessThanOrEqual(6); // 1 đọc + INSERT + outbox (Idempotency-Key ở Redis)
      const id = created.body.data.id as string;
      const req = await outbox('payment.withdrawal-requested', 'withdrawalId', id);
      expect(req).toHaveLength(1);
      expectEventMatchesContract(req[0]);
      const row = (
        await pg.query(`SELECT bank_snapshot::text AS s FROM withdrawal_requests WHERE id = $1`, [
          id,
        ])
      ).rows[0];
      expect(row.s).not.toContain('0011223344');

      const { n, result: done } = await countQueries(() =>
        as(users.admin).upload(`/api/v1/admin/withdrawals/${id}/complete`, png()),
      );
      expect(done.status).toBe(200);
      expect(done.body.data.status).toBe('COMPLETED');
      expect(n).toBe(7);
      const ev = await outbox('payment.withdrawal-completed', 'withdrawalId', id);
      expect(ev).toHaveLength(1);
      expectEventMatchesContract(ev[0]);
      expect(ev[0].payload).toEqual({
        withdrawalId: id,
        depositId: d.depositId,
        ownerId: users.owner.id,
        amountVnd: 3_000_000,
      });
      expect(await depositNet(d.depositId)).toBe(0);
      expect((await audits(id)).map((a) => a.action)).toEqual(['COMPLETE_WITHDRAWAL']);
    });

    it('test 6a: đơn REFUNDED (người thuê đã được hoàn 70%) → rút 30% = cọc − đã hoàn; sau khi hoàn tất ví về 0 cho đơn', async () => {
      const d = await paidDeposit(3_000_000);
      const refundId = (await internalRefund(d.depositId)).body.data.refundRequestId as string;
      expect(
        (await as(users.admin).upload(`/api/v1/admin/refund-requests/${refundId}/complete`, png()))
          .status,
      ).toBe(200);
      released(d, { status: 'REFUNDED' });

      const created = await as(users.owner).post('/api/v1/withdrawals', { depositId: d.depositId });
      expect(created.status).toBe(201);
      expect(created.body.data.amountVnd).toBe(900_000);
      const done = await as(users.admin).upload(
        `/api/v1/admin/withdrawals/${created.body.data.id}/complete`,
        png(),
      );
      expect(done.status).toBe(200);
      expect(await depositNet(d.depositId)).toBe(0);
    });

    it('test 6: đơn chưa RELEASED → 409 PAYMENT_WITHDRAWAL_NOT_ELIGIBLE kèm details.missing (Báo cáo T13)', async () => {
      const d = await paidDeposit();
      released(d, { status: 'PAID', eligible: false, missing: ['NOT_RELEASED'] });
      const res = await as(users.owner).post('/api/v1/withdrawals', { depositId: d.depositId });
      expect(res.status).toBe(409);
      expect(res.body.error).toMatchObject({
        code: 'PAYMENT_WITHDRAWAL_NOT_ELIGIBLE',
        details: { missing: ['NOT_RELEASED'] },
      });
    });

    it('test 7: lệnh rút lần hai → 409 PAYMENT_PAYOUT_ALREADY_OPEN; hai lệnh đồng thời → một 201 (ux_withdrawal_active)', async () => {
      const d = await paidDeposit();
      released(d);
      const [a, b] = await Promise.all([
        as(users.owner).post('/api/v1/withdrawals', { depositId: d.depositId }),
        as(users.owner).post('/api/v1/withdrawals', { depositId: d.depositId }),
      ]);
      expect([a.status, b.status].sort()).toEqual([201, 409]);
      const again = await as(users.owner).post('/api/v1/withdrawals', { depositId: d.depositId });
      expect([again.status, again.body.error.code]).toEqual([409, 'PAYMENT_PAYOUT_ALREADY_OPEN']);
    });

    it('test 8: chủ trọ chưa khai ngân hàng → 409 PAYMENT_BANK_ACCOUNT_MISSING, không ghi gì', async () => {
      const d = await paidDeposit(3_000_000, users.tenantA.id, users.otherOwner.id);
      released(d);
      const res = await as(users.otherOwner).post('/api/v1/withdrawals', {
        depositId: d.depositId,
      });
      expect([res.status, res.body.error.code]).toEqual([409, 'PAYMENT_BANK_ACCOUNT_MISSING']);
      const { rows } = await pg.query(
        `SELECT count(*) FROM withdrawal_requests WHERE deposit_id = $1`,
        [d.depositId],
      );
      expect(Number(rows[0].count)).toBe(0);
    });

    it('không phải chủ trọ của đơn → 403; đơn không có ở rental → 404 RENTAL_DEPOSIT_NOT_FOUND; người thuê gọi → 403', async () => {
      const d = await paidDeposit();
      released(d);
      expect(
        (await as(users.otherOwner).post('/api/v1/withdrawals', { depositId: d.depositId })).status,
      ).toBe(403);
      const nf = await as(users.owner).post('/api/v1/withdrawals', { depositId: randomUUID() });
      expect([nf.status, nf.body.error.code]).toEqual([404, 'RENTAL_DEPOSIT_NOT_FOUND']);
      expect(
        (await as(users.tenantA).post('/api/v1/withdrawals', { depositId: d.depositId })).status,
      ).toBe(403);
    });

    it('test 9: chứng từ đã dùng cho lệnh khác → 409 PAYMENT_RECEIPT_ALREADY_USED, lệnh vẫn PENDING, ví không đổi (Báo cáo T14)', async () => {
      const file = png('dung-chung');
      const d1 = await paidDeposit();
      released(d1);
      const w1 = (await as(users.owner).post('/api/v1/withdrawals', { depositId: d1.depositId }))
        .body.data.id;
      expect(
        (await as(users.admin).upload(`/api/v1/admin/withdrawals/${w1}/complete`, file)).status,
      ).toBe(200);

      const d2 = await paidDeposit();
      released(d2);
      const w2 = (await as(users.owner).post('/api/v1/withdrawals', { depositId: d2.depositId }))
        .body.data.id;
      const before = await balance();
      const res = await as(users.admin).upload(`/api/v1/admin/withdrawals/${w2}/complete`, file);
      expect([res.status, res.body.error.code]).toEqual([409, 'PAYMENT_RECEIPT_ALREADY_USED']);
      expect(
        (await pg.query(`SELECT status FROM withdrawal_requests WHERE id = $1`, [w2])).rows[0]
          .status,
      ).toBe('PENDING');
      expect(await balance()).toBe(before);
      expect(await audits(w2)).toHaveLength(0);
    });

    it('test 10: hai quản trị viên cùng hoàn tất một lệnh (Postgres thật) → một 200, một 409; ví trừ MỘT lần', async () => {
      const d = await paidDeposit();
      released(d);
      const id = (await as(users.owner).post('/api/v1/withdrawals', { depositId: d.depositId }))
        .body.data.id;
      const before = await balance();
      const [a, b] = await Promise.all([
        as(users.admin).upload(`/api/v1/admin/withdrawals/${id}/complete`, png()),
        as(users.admin2).upload(`/api/v1/admin/withdrawals/${id}/complete`, png()),
      ]);
      expect([a.status, b.status].sort()).toEqual([200, 409]);
      expect(await balance()).toBe(before - 3_000_000);
      const out = (
        await pg.query(
          `SELECT count(*) FROM wallet_transactions WHERE ref_type = 'WITHDRAWAL' AND ref_id = $1`,
          [id],
        )
      ).rows[0];
      expect(Number(out.count)).toBe(1);
      expect(await audits(id)).toHaveLength(1);
      expect(await outbox('payment.withdrawal-completed', 'withdrawalId', id)).toHaveLength(1);
    });

    it('test 11: lệnh rút FAILED → ví không đổi, 1 withdrawal-failed, 1 audit; chủ trọ tạo lệnh mới được', async () => {
      const d = await paidDeposit();
      released(d);
      const id = (await as(users.owner).post('/api/v1/withdrawals', { depositId: d.depositId }))
        .body.data.id;
      const before = await balance();
      const { n, result: res } = await countQueries(() =>
        as(users.admin).post(
          `/api/v1/admin/withdrawals/${id}/fail`,
          { reason: 'Sai tên chủ tài khoản' },
          null,
        ),
      );
      expect(res.status).toBe(200);
      expect(res.body.data.status).toBe('FAILED');
      expect(n).toBe(3);
      expect(await balance()).toBe(before);
      const ev = await outbox('payment.withdrawal-failed', 'withdrawalId', id);
      expect(ev).toHaveLength(1);
      expectEventMatchesContract(ev[0]);
      expect(await audits(id)).toHaveLength(1);
      expect(
        (await as(users.owner).post('/api/v1/withdrawals', { depositId: d.depositId })).status,
      ).toBe(201);
    });

    it('Idempotency-Key: hoàn tất gửi lại cùng khóa → trả lại kết quả cũ, ví trừ một lần; thiếu khóa → 400', async () => {
      const d = await paidDeposit();
      released(d);
      const id = (await as(users.owner).post('/api/v1/withdrawals', { depositId: d.depositId }))
        .body.data.id;
      const key = randomUUID();
      const file = png();
      const first = await as(users.admin).upload(`/api/v1/admin/withdrawals/${id}/complete`, file, {
        key,
      });
      const before = await balance();
      const second = await as(users.admin).upload(
        `/api/v1/admin/withdrawals/${id}/complete`,
        file,
        { key },
      );
      expect([first.status, second.status]).toEqual([200, 200]);
      expect(second.headers['idempotent-replayed']).toBe('true');
      expect(second.body.data).toEqual(first.body.data);
      expect(await balance()).toBe(before);
      const noKey = await as(users.admin).upload(
        `/api/v1/admin/withdrawals/${id}/complete`,
        png(),
        { key: null },
      );
      expect([noKey.status, noKey.body.error.code]).toEqual([400, 'IDEMPOTENCY_KEY_REQUIRED']);
    });

    it('test 16: chứng từ đổi đuôi, quá cỡ, thiếu tệp → 400 PAYMENT_RECEIPT_INVALID; lệnh vẫn PENDING', async () => {
      const d = await paidDeposit();
      released(d);
      const id = (await as(users.owner).post('/api/v1/withdrawals', { depositId: d.depositId }))
        .body.data.id;
      const path = `/api/v1/admin/withdrawals/${id}/complete`;

      const fake = await as(users.admin).upload(path, Buffer.from('%PDF-1.7 thật ra là pdf'), {
        mime: 'image/png',
      });
      expect([fake.status, fake.body.error.code, fake.body.error.details]).toEqual([
        400,
        'PAYMENT_RECEIPT_INVALID',
        { reason: 'CONTENT_MISMATCH' },
      ]);
      const big = await as(users.admin).upload(
        path,
        Buffer.concat([PNG_HEAD, Buffer.alloc(MAX_BYTES)]),
      );
      expect([big.status, big.body.error.code, big.body.error.details]).toEqual([
        400,
        'PAYMENT_RECEIPT_INVALID',
        { reason: 'TOO_LARGE' },
      ]);
      const none = await as(users.admin).post(path, undefined);
      expect([none.status, none.body.error.code]).toEqual([400, 'PAYMENT_RECEIPT_INVALID']);
      expect(
        (await pg.query(`SELECT status FROM withdrawal_requests WHERE id = $1`, [id])).rows[0]
          .status,
      ).toBe('PENDING');
    });

    it('reason: rỗng sau khi cắt, quá 500 ký tự → 400 VALIDATION_FAILED; lệnh không có → 404; đã COMPLETED → 409', async () => {
      const d = await paidDeposit();
      released(d);
      const id = (await as(users.owner).post('/api/v1/withdrawals', { depositId: d.depositId }))
        .body.data.id;
      const fail = (wid: string, reason: unknown) =>
        as(users.admin).post(`/api/v1/admin/withdrawals/${wid}/fail`, { reason }, null);
      expect((await fail(id, '   ')).status).toBe(400);
      expect((await fail(id, 'x'.repeat(501))).body.error.code).toBe('VALIDATION_FAILED');
      expect((await fail(randomUUID(), 'x')).body.error.code).toBe('PAYMENT_PAYOUT_NOT_FOUND');
      await as(users.admin).upload(`/api/v1/admin/withdrawals/${id}/complete`, png());
      const r = await fail(id, 'muộn');
      expect([r.status, r.body.error.code]).toEqual([409, 'PAYMENT_PAYOUT_INVALID_STATUS']);
    });

    it('test 15 + route 3, 4: chi tiết lệnh rút kèm số đầy đủ; danh sách của chủ trọ chỉ có lệnh của mình; lọc status', async () => {
      const d = await paidDeposit();
      released(d);
      const id = (await as(users.owner).post('/api/v1/withdrawals', { depositId: d.depositId }))
        .body.data.id;
      const detail = await as(users.admin).get(`/api/v1/admin/withdrawals/${id}`);
      expect(detail.body.data.bankAccount).toEqual({
        bankName: 'Vietcombank',
        accountHolder: 'CHU TRO',
        accountNumber: '0011223344',
      });

      const { n, result: mine } = await countQueries(() =>
        as(users.owner).get('/api/v1/withdrawals/mine'),
      );
      expect(mine.status).toBe(200);
      expect(n).toBe(2);
      expect(mine.body.data.every((w: { ownerId: string }) => w.ownerId === users.owner.id)).toBe(
        true,
      );
      expect((await as(users.otherOwner).get('/api/v1/withdrawals/mine')).body.data).toEqual([]);

      const pending = await as(users.admin).get('/api/v1/admin/withdrawals?status=PENDING');
      expect(pending.body.data.some((w: { id: string }) => w.id === id)).toBe(true);
      expect(pending.body.data.every((w: { status: string }) => w.status === 'PENDING')).toBe(true);
    });
  });

  // ======================================================================================
  describe('Route 1, 11, 12', () => {
    it('test 12: người A xem giao dịch → chỉ có giao dịch của A, không có của B (Báo cáo T15); 2 truy vấn', async () => {
      await paidDeposit(1_111, users.tenantA.id);
      await paidDeposit(2_222, users.tenantB.id);
      const { n, result: res } = await countQueries(() =>
        as(users.tenantA).get('/api/v1/payments/transactions/mine?pageSize=50'),
      );
      expect(res.status).toBe(200);
      expect(n).toBe(2);
      const amounts = res.body.data.map((x: { amountVnd: number }) => x.amountVnd);
      expect(amounts).toContain(1_111);
      expect(amounts).not.toContain(2_222);
      const ownerView = await as(users.owner).get('/api/v1/payments/transactions/mine?pageSize=50');
      expect(ownerView.body.data.map((x: { amountVnd: number }) => x.amountVnd)).toEqual(
        expect.arrayContaining([1_111, 2_222]),
      );
    });

    it('route 11: số dư khớp admin_wallet; tổng đang chờ khớp DB; 1 truy vấn', async () => {
      const { n, result: res } = await countQueries(() =>
        as(users.admin).get('/api/v1/admin/wallet'),
      );
      expect(res.status).toBe(200);
      expect(n).toBe(1);
      expect(res.body.data.balanceVnd).toBe(await balance());
      const { rows } = await pg.query(
        `SELECT (SELECT COALESCE(SUM(amount_vnd),0) FROM withdrawal_requests WHERE status = 'PENDING') AS w,
                (SELECT COALESCE(SUM(amount_vnd),0) FROM refund_requests WHERE status IN ('PENDING_ADMIN','FAILED')) AS r`,
      );
      expect(res.body.data).toMatchObject({
        pendingWithdrawalVnd: Number(rows[0].w),
        pendingRefundVnd: Number(rows[0].r),
      });
    });

    it('test 14 + route 12: mỗi thao tác quản trị có đúng một dòng audit_log; lọc targetType', async () => {
      const total = Number((await pg.query(`SELECT count(*) FROM audit_log`)).rows[0].count);
      // Các test trên: thao tác thành công nào cũng có audit, thao tác lỗi thì không
      expect(total).toBeGreaterThan(0);
      const res = await as(users.admin).get(
        '/api/v1/admin/audit-logs?targetType=WITHDRAWAL&pageSize=50',
      );
      expect(res.status).toBe(200);
      expect(
        res.body.data.every((a: { targetType: string }) => a.targetType === 'WITHDRAWAL'),
      ).toBe(true);
      expect(res.body.meta.total).toBe(
        Number(
          (await pg.query(`SELECT count(*) FROM audit_log WHERE target_type = 'WITHDRAWAL'`))
            .rows[0].count,
        ),
      );
    });
  });

  describe('Index danh sách route 3, 4, 5, 12 (API_Spec §7, non-functional §Index)', () => {
    // Đúng câu SQL `PayoutQueryService.page()` sinh ra; tắt seq scan để xem planner có index dùng được
    // cho cả bộ lọc lẫn ORDER BY hay không (bảng thử nhỏ nên bình thường planner chọn seq scan).
    const PAGE = 'ORDER BY created_at DESC, id DESC LIMIT 20 OFFSET 0';
    const cases: Array<[string, string, string, unknown[], string]> = [
      [
        'route 3 owner_id',
        'withdrawal_requests',
        'owner_id = $1',
        [randomUUID()],
        'ix_withdrawal_owner_created',
      ],
      [
        'route 4 lọc status',
        'withdrawal_requests',
        '($1::text IS NULL OR status = $1)',
        ['PENDING'],
        'ix_withdrawal_status_created',
      ],
      [
        'route 4 không lọc',
        'withdrawal_requests',
        '($1::text IS NULL OR status = $1)',
        [null],
        'ix_withdrawal_created',
      ],
      [
        'route 5 lọc status',
        'refund_requests',
        '($1::text IS NULL OR status = $1)',
        ['PENDING_ADMIN'],
        'ix_refund_status_created',
      ],
      [
        'route 5 không lọc',
        'refund_requests',
        '($1::text IS NULL OR status = $1)',
        [null],
        'ix_refund_created',
      ],
      [
        'route 12 lọc targetId',
        'audit_log',
        '($1::text IS NULL OR target_type = $1) AND ($2::uuid IS NULL OR target_id = $2)',
        [null, randomUUID()],
        'ix_audit_target_created',
      ],
      [
        'route 12 không lọc',
        'audit_log',
        '($1::text IS NULL OR target_type = $1) AND ($2::uuid IS NULL OR target_id = $2)',
        [null, null],
        'ix_audit_created',
      ],
    ];

    it.each(cases)('%s → %s dùng %s', async (_name, table, where, params, index) => {
      await pg.query('BEGIN');
      try {
        await pg.query('SET LOCAL enable_seqscan = off');
        const { rows } = await pg.query(
          `EXPLAIN SELECT * FROM ${table} WHERE ${where} ${PAGE}`,
          params,
        );
        const plan = rows.map((r: { 'QUERY PLAN': string }) => r['QUERY PLAN']).join('\n');
        expect(plan).toContain(index);
        expect(plan).not.toMatch(/\bSort\b/);
      } finally {
        await pg.query('ROLLBACK');
      }
    });
  });
});
