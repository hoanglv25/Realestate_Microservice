import { NodeCryptoProvider } from '@payos/node/lib/crypto/node-crypto';
import { randomUUID } from 'node:crypto';
import { createServer, IncomingMessage, Server, ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Client } from 'pg';
import { DataSource } from 'typeorm';
import { expectResponseMatchesOpenApi } from './helpers/contracts';
import type { TestApp } from './helpers/create-test-app';
import { INFRA_TEST_SCHEMA } from './helpers/infra';

/**
 * API nội bộ `/internal/payment-orders*` với Postgres THẬT và SDK `@payos/node` THẬT, trỏ vào một máy chủ payOS
 * GIẢ qua `PAYOS_BASE_URL` (không gọi payOS thật, không cần khóa thật). Máy chủ giả ký `data` bằng
 * `PAYOS_CHECKSUM_KEY` như payOS, nên SDK kiểm chữ ký response như lúc chạy thật.
 *
 * Test 7–10 của `RE.PAYMENT/Component_Class_Design.md §4` (DoD T3.1); mọi response khớp
 * `contracts/openapi/payment-internal.v1.yaml`; đếm truy vấn (ngưỡng ghi 6).
 */
const SPEC = 'payment-internal.v1.yaml';
const CHECKSUM_KEY = 'checksum-key-chi-de-test';
const TIMEOUT_MS = 400;
/** Biến file này tự đặt (khóa giả chung đặt ở setup-infra-env.ts). */
const PAYOS_ENV = ['PAYOS_CHECKSUM_KEY', 'PAYOS_BASE_URL', 'PAYOS_TIMEOUT_MS'];

interface PayosCall {
  op: 'create' | 'cancel';
  orderCode: number;
  body: Record<string, unknown>;
  /** Trạng thái order trong DB ĐÚNG LÚC payOS nhận request (null = chưa có dòng). */
  statusInDb: string | null;
}

const inMinutes = (m: number): Date => new Date(Date.now() + m * 60_000);

describe('API nội bộ payment order với hạ tầng thật (payOS giả)', () => {
  let t: TestApp;
  let pg: Client;
  let ds: DataSource;
  let payos: Server;
  const calls: PayosCall[] = [];
  const queries: string[] = [];
  /** Hành vi của payOS giả cho request kế tiếp. */
  let behavior: {
    delayMs?: number;
    httpStatus?: number;
    /** Chạy ngay trước khi payOS giả trả lời lệnh hủy (giả lập webhook thắng giữa chừng). */
    beforeCancelReply?: (orderCode: number) => Promise<void>;
  } = {};
  const crypto = new NodeCryptoProvider();

  const body = (over: Record<string, unknown> = {}) => ({
    depositId: randomUUID(),
    tenantId: randomUUID(),
    ownerId: randomUUID(),
    listingTitle: 'Phòng 25m2 gần ĐH Bách Khoa',
    amountVnd: 3_000_000,
    expiresAt: inMinutes(10).toISOString(),
    ...over,
  });
  const create = (b: Record<string, unknown>) => t.http().post('/internal/payment-orders').send(b);
  const cancel = (depositId: string) =>
    t.http().post(`/internal/payment-orders/${depositId}/cancel`);
  const get = (depositId: string) => t.http().get(`/internal/payment-orders/${depositId}`);
  const row = async (depositId: string) =>
    (await pg.query(`SELECT * FROM payment_orders WHERE deposit_id = $1`, [depositId])).rows[0];
  const rowCount = async (depositId: string) =>
    Number(
      (await pg.query(`SELECT count(*) FROM payment_orders WHERE deposit_id = $1`, [depositId]))
        .rows[0].count,
    );
  const callsFor = (op: PayosCall['op'], orderCode: number) =>
    calls.filter((c) => c.op === op && c.orderCode === orderCode);
  const matches = (method: 'GET' | 'POST', path: string, status: number, resBody: unknown) =>
    expect(() => expectResponseMatchesOpenApi(SPEC, method, path, status, resBody)).not.toThrow();

  async function countQueries(call: () => Promise<unknown>): Promise<number> {
    queries.length = 0;
    await call();
    return queries.filter(
      (q) =>
        !/^(START TRANSACTION|COMMIT|ROLLBACK)/i.test(q.trim()) &&
        // truy vấn nền của OutboxRelay (khi có RabbitMQ) không thuộc request
        !/published_at IS NULL|UPDATE outbox_events/i.test(q),
    ).length;
  }

  async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
    let raw = '';
    for await (const chunk of req) raw += String(chunk);
    return raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
  }

  async function reply(res: ServerResponse, data: Record<string, unknown>): Promise<void> {
    if (res.destroyed) return;
    const signature = await crypto.createSignatureFromObj(data, CHECKSUM_KEY);
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ code: '00', desc: 'success', data, signature }));
  }

  /** payOS giả: `POST /v2/payment-requests`, `POST /v2/payment-requests/:orderCode/cancel`. */
  function handle(req: IncomingMessage, res: ServerResponse): void {
    void (async () => {
      const b = await readJson(req);
      const cancelMatch = /^\/v2\/payment-requests\/(\d+)\/cancel$/.exec(req.url ?? '');
      const op: PayosCall['op'] = cancelMatch ? 'cancel' : 'create';
      const orderCode = cancelMatch ? Number(cancelMatch[1]) : Number(b.orderCode);
      const found = await pg.query(
        `SELECT status FROM payment_orders WHERE payos_order_code = $1`,
        [orderCode],
      );
      calls.push({ op, orderCode, body: b, statusInDb: found.rows[0]?.status ?? null });

      const { delayMs, httpStatus, beforeCancelReply } = behavior;
      if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
      if (httpStatus) {
        res.writeHead(httpStatus, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ code: '99', desc: 'Lỗi hệ thống' }));
        return;
      }
      if (op === 'create') {
        await reply(res, {
          bin: '970422',
          accountNumber: '0123456789',
          accountName: 'CONG TY REALESTATE',
          amount: b.amount,
          description: b.description,
          orderCode,
          currency: 'VND',
          paymentLinkId: `link-${orderCode}`,
          status: 'PENDING',
          expiredAt: b.expiredAt,
          checkoutUrl: `https://pay.payos.vn/web/link-${orderCode}`,
          qrCode: `00020101021238570010A0000007270127${orderCode}`,
        });
        return;
      }
      if (beforeCancelReply) await beforeCancelReply(orderCode);
      await reply(res, {
        id: `link-${orderCode}`,
        orderCode,
        amount: 3_000_000,
        amountPaid: 0,
        amountRemaining: 3_000_000,
        status: 'CANCELLED',
        createdAt: new Date().toISOString(),
        transactions: [],
        cancellationReason: String(b.cancellationReason ?? ''),
        canceledAt: new Date().toISOString(),
      });
    })().catch(() => {
      if (!res.headersSent) res.writeHead(500).end();
    });
  }

  beforeAll(async () => {
    payos = createServer(handle);
    await new Promise<void>((r) => payos.listen(0, '127.0.0.1', r));
    const { port } = payos.address() as AddressInfo;

    pg = new Client({ connectionString: process.env.DATABASE_URL });
    await pg.connect();
    await pg.query(`DROP SCHEMA IF EXISTS ${INFRA_TEST_SCHEMA} CASCADE`);
    await pg.query(`CREATE SCHEMA ${INFRA_TEST_SCHEMA}`);
    Object.assign(process.env, {
      PAYOS_CHECKSUM_KEY: CHECKSUM_KEY,
      PAYOS_BASE_URL: `http://127.0.0.1:${port}`,
      PAYOS_TIMEOUT_MS: String(TIMEOUT_MS),
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
    await new Promise((r) => payos?.close(r));
    for (const name of PAYOS_ENV) delete process.env[name];
  });

  beforeEach(() => {
    behavior = {};
  });

  describe('tạo order (API_Spec §2a)', () => {
    it('tạo mới -> 201; INSERT trước khi gọi payOS; link lưu DB; khớp hợp đồng', async () => {
      const b = body();
      const res = await create(b);

      expect(res.status).toBe(201);
      matches('POST', '/internal/payment-orders', 201, res.body);
      const saved = await row(b.depositId);
      expect(saved).toMatchObject({
        status: 'PENDING',
        amount_vnd: '3000000',
        listing_title: b.listingTitle,
        payos_payment_link_id: `link-${saved.payos_order_code}`,
      });
      expect(res.body.data).toEqual({
        orderId: saved.id,
        payosOrderCode: Number(saved.payos_order_code),
        checkoutUrl: saved.checkout_url,
        qrCode: saved.qr_code,
        expiresAt: b.expiresAt,
      });
      const [call] = callsFor('create', Number(saved.payos_order_code));
      expect(call.statusInDb).toBe('PENDING'); // order có trong DB trước khi gọi payOS
      expect(call.body).toMatchObject({
        orderCode: Number(saved.payos_order_code),
        amount: 3_000_000,
        expiredAt: Math.floor(new Date(b.expiresAt).getTime() / 1000),
      });
      expect(Number(saved.payos_order_code)).toBeGreaterThanOrEqual(100000); // sequence START 100000
    });

    it('test 7: tạo hai lần cùng depositId -> lần hai 200 trả order cũ; MỘT order, MỘT lần gọi payOS', async () => {
      const b = body();
      const first = await create(b);
      const second = await create(b);

      expect(second.status).toBe(200);
      matches('POST', '/internal/payment-orders', 200, second.body);
      expect(second.body.data).toEqual(first.body.data);
      expect(await rowCount(b.depositId)).toBe(1);
      expect(callsFor('create', first.body.data.payosOrderCode)).toHaveLength(1);
    });

    it('hai lệnh tạo ĐỒNG THỜI cùng depositId -> một order, một lần gọi payOS, đúng một 201', async () => {
      const b = body();
      behavior = { delayMs: 100 };
      const results = await Promise.all([create(b), create(b), create(b)]);

      expect(await rowCount(b.depositId)).toBe(1);
      const saved = await row(b.depositId);
      expect(callsFor('create', Number(saved.payos_order_code))).toHaveLength(1);
      const statuses = results.map((r) => r.status);
      expect(statuses.filter((s) => s === 201)).toHaveLength(1);
      // Bên thua thấy order chưa có link (bên thắng đang gọi payOS) -> 503 như C23, hoặc 200 nếu link đã lưu
      for (const s of statuses) expect([200, 201, 503]).toContain(s);
    });

    it('test 8: payOS quá PAYOS_TIMEOUT_MS -> 503 PAYMENT_PROVIDER_UNAVAILABLE; order có TRƯỚC khi gọi, giữ PENDING không link', async () => {
      const b = body();
      behavior = { delayMs: TIMEOUT_MS * 3 };
      const started = Date.now();
      const res = await create(b);

      expect(res.status).toBe(503);
      expect(res.body.error.code).toBe('PAYMENT_PROVIDER_UNAVAILABLE');
      matches('POST', '/internal/payment-orders', 503, res.body);
      expect(Date.now() - started).toBeLessThan(TIMEOUT_MS * 3); // không chờ payOS, không retry
      const saved = await row(b.depositId);
      expect(saved).toMatchObject({
        status: 'PENDING',
        checkout_url: null,
        payos_payment_link_id: null,
      });
      const made = callsFor('create', Number(saved.payos_order_code));
      expect(made).toHaveLength(1);
      expect(made[0].statusInDb).toBe('PENDING');
    });

    it('payOS 5xx -> 503, KHÔNG retry tạo link (đúng một request tới payOS)', async () => {
      const b = body();
      behavior = { httpStatus: 502 };
      const res = await create(b);

      expect(res.status).toBe(503);
      const saved = await row(b.depositId);
      expect(callsFor('create', Number(saved.payos_order_code))).toHaveLength(1);
    });

    it('C23: gọi lại khi order PENDING chưa có link (lần trước payOS lỗi) -> 503, không gọi payOS lần hai', async () => {
      const b = body();
      behavior = { httpStatus: 502 };
      await create(b);
      behavior = {};
      const again = await create(b);

      expect(again.status).toBe(503);
      const saved = await row(b.depositId);
      expect(callsFor('create', Number(saved.payos_order_code))).toHaveLength(1);
    });

    it('expiresAt đã qua -> 409 PAYMENT_ORDER_EXPIRED, không tạo gì', async () => {
      const b = body({ expiresAt: inMinutes(-1).toISOString() });
      const res = await create(b);
      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe('PAYMENT_ORDER_EXPIRED');
      matches('POST', '/internal/payment-orders', 409, res.body);
      expect(await rowCount(b.depositId)).toBe(0);
    });

    it.each([
      ['PAID', 'PAYMENT_ORDER_ALREADY_PAID'],
      ['CANCELLED', 'PAYMENT_ORDER_CANCELLED'],
    ])('đơn đã có order %s -> 409 %s', async (status, code) => {
      const b = body();
      await create(b);
      await pg.query(`UPDATE payment_orders SET status = $2 WHERE deposit_id = $1`, [
        b.depositId,
        status,
      ]);
      const res = await create(b);
      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe(code);
      matches('POST', '/internal/payment-orders', 409, res.body);
    });

    it('body sai (UUID, số tiền, múi giờ, trường lạ) -> 400 VALIDATION_FAILED, khớp hợp đồng', async () => {
      for (const over of [
        { depositId: 'abc' },
        { amountVnd: 0 },
        { expiresAt: '2026-11-20T08:10:00' },
        { status: 'PAID' },
      ]) {
        const res = await create(body(over));
        expect(res.status).toBe(400);
        expect(res.body.error.code).toBe('VALIDATION_FAILED');
        matches('POST', '/internal/payment-orders', 400, res.body);
      }
    });

    it('số truy vấn: tạo mới 3 (SELECT, INSERT, UPDATE link); gọi lại 1 (ngưỡng ghi 6)', async () => {
      const b = body();
      expect(await countQueries(() => create(b))).toBe(3);
      expect(await countQueries(() => create(b))).toBe(1);
    });
  });

  describe('hủy order (API_Spec §2b)', () => {
    it('test 9: hủy PENDING -> payOS cancel gọi TRƯỚC UPDATE (lúc payOS nhận lệnh, DB còn PENDING); 200 CANCELLED', async () => {
      const b = body();
      const created = await create(b);
      const orderCode = created.body.data.payosOrderCode as number;

      const res = await cancel(b.depositId);

      expect(res.status).toBe(200);
      matches('POST', '/internal/payment-orders/{depositId}/cancel', 200, res.body);
      expect(res.body.data).toEqual({
        orderId: created.body.data.orderId,
        depositId: b.depositId,
        status: 'CANCELLED',
      });
      const [call] = callsFor('cancel', orderCode);
      expect(call.statusInDb).toBe('PENDING');
      const saved = await row(b.depositId);
      expect(saved.status).toBe('CANCELLED');
      expect(saved.cancelled_at).toBeInstanceOf(Date);
    });

    it('test 10: webhook thắng giữa lúc hủy (order thành PAID trước UPDATE) -> 409 PAYMENT_ORDER_ALREADY_PAID, order giữ PAID', async () => {
      const b = body();
      const created = await create(b);
      behavior = {
        beforeCancelReply: async (orderCode) => {
          await pg.query(
            `UPDATE payment_orders SET status = 'PAID', paid_at = now(), payos_reference = $2 WHERE payos_order_code = $1`,
            [orderCode, `FT${orderCode}`],
          );
        },
      };

      const res = await cancel(b.depositId);

      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe('PAYMENT_ORDER_ALREADY_PAID');
      matches('POST', '/internal/payment-orders/{depositId}/cancel', 409, res.body);
      expect((await row(b.depositId)).status).toBe('PAID');
      expect(callsFor('cancel', created.body.data.payosOrderCode)).toHaveLength(1);
    });

    it('đã PAID từ trước -> 409, không gọi payOS', async () => {
      const b = body();
      const created = await create(b);
      await pg.query(`UPDATE payment_orders SET status = 'PAID' WHERE deposit_id = $1`, [
        b.depositId,
      ]);
      const res = await cancel(b.depositId);
      expect(res.status).toBe(409);
      expect(callsFor('cancel', created.body.data.payosOrderCode)).toHaveLength(0);
    });

    it('hủy hai lần -> lần hai 200 (idempotent), payOS chỉ nhận một lệnh hủy', async () => {
      const b = body();
      const created = await create(b);
      await cancel(b.depositId);
      const again = await cancel(b.depositId);
      expect(again.status).toBe(200);
      matches('POST', '/internal/payment-orders/{depositId}/cancel', 200, again.body);
      expect(callsFor('cancel', created.body.data.payosOrderCode)).toHaveLength(1);
    });

    it('order chưa có link (tạo link lỗi) -> hủy không gọi payOS, vẫn CANCELLED', async () => {
      const b = body();
      behavior = { httpStatus: 502 };
      await create(b);
      behavior = {};
      const orderCode = Number((await row(b.depositId)).payos_order_code);

      const res = await cancel(b.depositId);
      expect(res.status).toBe(200);
      expect(callsFor('cancel', orderCode)).toHaveLength(0);
      expect((await row(b.depositId)).status).toBe('CANCELLED');
    });

    it('payOS lỗi khi hủy -> 503, order giữ PENDING', async () => {
      const b = body();
      await create(b);
      behavior = { delayMs: TIMEOUT_MS * 3 };
      const res = await cancel(b.depositId);
      expect(res.status).toBe(503);
      expect(res.body.error.code).toBe('PAYMENT_PROVIDER_UNAVAILABLE');
      matches('POST', '/internal/payment-orders/{depositId}/cancel', 503, res.body);
      expect((await row(b.depositId)).status).toBe('PENDING');
    });

    it('không có order -> 404; depositId sai -> 400; khớp hợp đồng', async () => {
      const missing = await cancel(randomUUID());
      expect(missing.status).toBe(404);
      expect(missing.body.error.code).toBe('PAYMENT_ORDER_NOT_FOUND');
      matches('POST', '/internal/payment-orders/{depositId}/cancel', 404, missing.body);
      const bad = await cancel('khong-phai-uuid');
      expect(bad.status).toBe(400);
      matches('POST', '/internal/payment-orders/{depositId}/cancel', 400, bad.body);
    });

    it('số truy vấn: hủy 2 (SELECT, UPDATE)', async () => {
      const b = body();
      await create(b);
      expect(await countQueries(() => cancel(b.depositId))).toBe(2);
    });
  });

  describe('tra cứu (API_Spec §2c)', () => {
    it('200 đúng trường PaymentOrder; PAID có paidAt; 1 truy vấn; khớp hợp đồng', async () => {
      const b = body();
      const created = await create(b);
      await pg.query(
        `UPDATE payment_orders SET status = 'PAID', paid_at = '2026-11-20T08:05:00Z' WHERE deposit_id = $1`,
        [b.depositId],
      );
      let res!: Awaited<ReturnType<typeof get>>;
      expect(
        await countQueries(async () => {
          res = await get(b.depositId);
        }),
      ).toBe(1);

      expect(res.status).toBe(200);
      matches('GET', '/internal/payment-orders/{depositId}', 200, res.body);
      expect(res.body.data).toEqual({
        orderId: created.body.data.orderId,
        depositId: b.depositId,
        status: 'PAID',
        amountVnd: 3_000_000,
        payosOrderCode: created.body.data.payosOrderCode,
        checkoutUrl: created.body.data.checkoutUrl,
        expiresAt: b.expiresAt,
        paidAt: '2026-11-20T08:05:00.000Z',
      });
    });

    it('order chưa có link -> checkoutUrl null (khớp hợp đồng)', async () => {
      const b = body();
      behavior = { httpStatus: 502 };
      await create(b);
      const res = await get(b.depositId);
      expect(res.status).toBe(200);
      expect(res.body.data).toMatchObject({ status: 'PENDING', checkoutUrl: null, paidAt: null });
      matches('GET', '/internal/payment-orders/{depositId}', 200, res.body);
    });

    it('không có -> 404; id sai -> 400', async () => {
      const missing = await get(randomUUID());
      expect(missing.status).toBe(404);
      matches('GET', '/internal/payment-orders/{depositId}', 404, missing.body);
      expect((await get('123')).status).toBe(400);
    });
  });

  it('migration: đủ bảng của RE.PAYMENT §6 và RE.PAYOUT §7; ví có đúng một dòng, số dư 0', async () => {
    const tables = (
      await pg.query(
        `SELECT table_name FROM information_schema.tables WHERE table_schema = $1 ORDER BY 1`,
        [INFRA_TEST_SCHEMA],
      )
    ).rows.map((r: { table_name: string }) => r.table_name);
    for (const name of [
      'payment_orders',
      'payos_webhook_events',
      'late_payments',
      'admin_wallet',
      'wallet_transactions',
      'refund_requests',
      'withdrawal_requests',
      'transfer_receipts',
      'audit_log',
    ]) {
      expect(tables).toContain(name);
    }
    expect((await pg.query(`SELECT id, balance_vnd FROM admin_wallet`)).rows).toEqual([
      { id: 1, balance_vnd: '0' },
    ]);
  });
});
