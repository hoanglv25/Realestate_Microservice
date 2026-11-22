import { NodeCryptoProvider } from '@payos/node/lib/crypto/node-crypto';
import { randomUUID } from 'node:crypto';
import { Client } from 'pg';
import { DataSource } from 'typeorm';
import type { DomainEvent } from '../src/messaging/domain-event';
import { expectEventMatchesContract } from './helpers/contracts';
import type { TestApp } from './helpers/create-test-app';
import { INFRA_TEST_SCHEMA } from './helpers/infra';

/**
 * Webhook payOS `POST /api/v1/payments/payos/webhook` với Postgres THẬT (T3.4a).
 *
 * Test 1–6, 10–12 của `RE.PAYMENT/Component_Class_Design.md §4`; số truy vấn `PAID` 7, `LATE` 8 (ngưỡng 8, nhánh đua
 * 9 A chấp nhận 2026-11-22). Webhook được ký bằng chính thuật toán của SDK payOS với `PAYOS_CHECKSUM_KEY` của test
 * (setup-infra-env.ts), nên `webhooks.verify` của SDK kiểm như lúc chạy thật. Không gọi payOS: order chèn thẳng vào
 * DB chưa có link (lệnh hủy không gọi payOS).
 */
const PATH = '/api/v1/payments/payos/webhook';

describe('Webhook payOS với hạ tầng thật', () => {
  let t: TestApp;
  let pg: Client;
  let ds: DataSource;
  const queries: string[] = [];
  const crypto = new NodeCryptoProvider();
  const key = () => process.env.PAYOS_CHECKSUM_KEY as string;

  interface Order {
    id: string;
    depositId: string;
    tenantId: string;
    ownerId: string;
    orderCode: number;
    amountVnd: number;
  }

  async function newOrder(amountVnd = 2_000, status = 'PENDING'): Promise<Order> {
    const o = { depositId: randomUUID(), tenantId: randomUUID(), ownerId: randomUUID(), amountVnd };
    const { rows } = await pg.query(
      `INSERT INTO payment_orders (deposit_id, tenant_id, owner_id, listing_title, amount_vnd, payos_order_code,
         expires_at, status, cancelled_at)
       VALUES ($1, $2, $3, 'Phòng test', $4, nextval('payos_order_code_seq'), now() + interval '10 minutes', $5::varchar,
         CASE WHEN $5::varchar = 'CANCELLED' THEN now() END)
       RETURNING id, payos_order_code`,
      [o.depositId, o.tenantId, o.ownerId, amountVnd, status],
    );
    return { ...o, id: rows[0].id, orderCode: Number(rows[0].payos_order_code) };
  }

  const ref = () => `FT${Date.now()}${Math.floor(Math.random() * 1e6)}`;

  async function webhook(
    data: Record<string, unknown>,
    opts: { badKey?: boolean; success?: boolean } = {},
  ) {
    const full: Record<string, unknown> = {
      description: `DC${String(data.orderCode)}`,
      accountNumber: '4025072005',
      transactionDateTime: '2026-11-22 22:40:00',
      currency: 'VND',
      paymentLinkId: `link-${String(data.orderCode)}`,
      code: '00',
      desc: 'success',
      counterAccountBankId: '970422',
      counterAccountBankName: 'MB',
      counterAccountName: 'NGUOI THUE',
      counterAccountNumber: '0123456789',
      virtualAccountName: '',
      virtualAccountNumber: '',
      ...data,
    };
    const signature = await crypto.createSignatureFromObj(full, opts.badKey ? 'khoa-sai' : key());
    return {
      code: opts.success === false ? '01' : '00',
      desc: opts.success === false ? 'failed' : 'success',
      success: opts.success !== false,
      data: full,
      signature,
    };
  }

  const post = (b: unknown) =>
    t
      .http()
      .post(PATH)
      .send(b as object);
  const order = async (id: string) =>
    (await pg.query(`SELECT * FROM payment_orders WHERE id = $1`, [id])).rows[0];
  const events = async (reference: string) =>
    (
      await pg.query(
        `SELECT * FROM payos_webhook_events WHERE reference = $1 ORDER BY received_at`,
        [reference],
      )
    ).rows;
  const walletTx = async (depositId: string) =>
    (await pg.query(`SELECT * FROM wallet_transactions WHERE deposit_id = $1`, [depositId])).rows;
  const balance = async () =>
    Number(
      (await pg.query(`SELECT balance_vnd FROM admin_wallet WHERE id = 1`)).rows[0].balance_vnd,
    );
  const outbox = async (eventType: string, depositId: string) =>
    (
      await pg.query(
        `SELECT envelope FROM outbox_events WHERE event_type = $1 AND envelope->'payload'->>'depositId' = $2`,
        [eventType, depositId],
      )
    ).rows.map((r) => r.envelope as DomainEvent<Record<string, unknown>>);

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

  beforeAll(async () => {
    pg = new Client({ connectionString: process.env.DATABASE_URL });
    await pg.connect();
    await pg.query(`DROP SCHEMA IF EXISTS ${INFRA_TEST_SCHEMA} CASCADE`);
    await pg.query(`CREATE SCHEMA ${INFRA_TEST_SCHEMA}`);
    process.env.SERVICE_NAME = 'payment'; // producer của sự kiện phải là "payment" (contracts/events)
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
    process.env.SERVICE_NAME = 'template-nest-test';
  });

  // Test 12 (E10): sau MỖI test, số dư ví = tổng vào − tổng ra
  afterEach(async () => {
    const { rows } = await pg.query(
      `SELECT (SELECT balance_vnd FROM admin_wallet WHERE id = 1) AS balance,
              COALESCE(SUM(CASE WHEN type IN ('DEPOSIT_IN','LATE_PAYMENT_IN') THEN amount_vnd ELSE -amount_vnd END), 0)
                AS expected
         FROM wallet_transactions`,
    );
    expect(Number(rows[0].balance)).toBe(Number(rows[0].expected));
  });

  it('test 1: webhook hợp lệ -> 200 body cố định; order PAID; 1 DEPOSIT_IN; số dư tăng đúng; 1 payment.deposited đúng hợp đồng', async () => {
    const o = await newOrder(2_000);
    const reference = ref();
    const before = await balance();

    const res = await post(await webhook({ orderCode: o.orderCode, amount: 2_000, reference }));

    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ received: true });
    expect(await order(o.id)).toMatchObject({ status: 'PAID', payos_reference: reference });
    expect((await order(o.id)).paid_at.toISOString()).toBe('2026-11-22T15:40:00.000Z'); // 22:40 giờ VN
    const tx = await walletTx(o.depositId);
    expect(tx).toHaveLength(1);
    expect(tx[0]).toMatchObject({
      type: 'DEPOSIT_IN',
      amount_vnd: '2000',
      ref_type: 'ORDER',
      ref_id: o.id,
    });
    expect(await balance()).toBe(before + 2_000);
    const [ev] = await outbox('payment.deposited', o.depositId);
    expectEventMatchesContract(ev); // test 11
    expect(ev.payload).toEqual({
      depositId: o.depositId,
      orderId: o.id,
      tenantId: o.tenantId,
      ownerId: o.ownerId,
      amountVnd: 2_000,
      payosReference: reference,
      paidAt: '2026-11-22T15:40:00.000Z',
    });
    const [saved] = await events(reference);
    expect(saved).toMatchObject({
      result: 'PAID',
      signature_valid: true,
      order_code: String(o.orderCode),
    });
    expect(saved.raw.data.reference).toBe(reference); // nguyên văn
  });

  it('test 2 (Báo cáo T10): cùng webhook gửi hai lần -> lần hai DUPLICATE; MỘT giao dịch ví, MỘT sự kiện', async () => {
    const o = await newOrder();
    const body = await webhook({ orderCode: o.orderCode, amount: 2_000, reference: ref() });

    expect((await post(body)).status).toBe(200);
    expect((await post(body)).status).toBe(200);

    expect((await events(body.data.reference as string)).map((e) => e.result)).toEqual([
      'PAID',
      'DUPLICATE',
    ]);
    expect(await walletTx(o.depositId)).toHaveLength(1);
    expect(await outbox('payment.deposited', o.depositId)).toHaveLength(1);
  });

  it('test 3: năm webhook cùng reference ĐỒNG THỜI -> đúng một PAID, còn lại DUPLICATE; một giao dịch ví, một sự kiện', async () => {
    const o = await newOrder();
    const body = await webhook({ orderCode: o.orderCode, amount: 2_000, reference: ref() });

    const results = await Promise.all(Array.from({ length: 5 }, () => post(body)));

    expect(results.map((r) => r.status)).toEqual([200, 200, 200, 200, 200]);
    const res = (await events(body.data.reference as string)).map((e) => e.result).sort();
    expect(res).toEqual(['DUPLICATE', 'DUPLICATE', 'DUPLICATE', 'DUPLICATE', 'PAID']);
    expect(await walletTx(o.depositId)).toHaveLength(1);
    expect(await outbox('payment.deposited', o.depositId)).toHaveLength(1);
    expect(await late(o.depositId)).toHaveLength(0);
  });

  it('test 4 (Báo cáo T09): sai chữ ký -> 200, INVALID_SIGNATURE, order PENDING, ví không đổi, log warn', async () => {
    const o = await newOrder();
    const before = await balance();
    const body = await webhook(
      { orderCode: o.orderCode, amount: 2_000, reference: ref() },
      { badKey: true },
    );

    expect((await post(body)).status).toBe(200);

    expect((await events(body.data.reference as string))[0]).toMatchObject({
      result: 'INVALID_SIGNATURE',
      signature_valid: false,
    });
    expect((await order(o.id)).status).toBe('PENDING');
    expect(await balance()).toBe(before);
    expect(t.logRecords().some((l) => l.level === 'warn' && l.result === 'INVALID_SIGNATURE')).toBe(
      true,
    );
  });

  it('test 5 (Báo cáo T09): sai số tiền với order PENDING -> AMOUNT_MISMATCH, order PENDING, ví không đổi', async () => {
    const o = await newOrder(2_000);
    const before = await balance();
    const body = await webhook({ orderCode: o.orderCode, amount: 1_000, reference: ref() });

    expect((await post(body)).status).toBe(200);

    expect((await events(body.data.reference as string))[0].result).toBe('AMOUNT_MISMATCH');
    expect((await order(o.id)).status).toBe('PENDING');
    expect(await balance()).toBe(before);
    expect(await walletTx(o.depositId)).toHaveLength(0);
  });

  const late = async (depositId: string) =>
    (await pg.query(`SELECT * FROM late_payments WHERE deposit_id = $1`, [depositId])).rows;
  const refunds = async (depositId: string) =>
    (await pg.query(`SELECT * FROM refund_requests WHERE deposit_id = $1`, [depositId])).rows;

  it('test 6 (E5): webhook cho order CANCELLED -> late_payments, LATE_PAYMENT_IN, yêu cầu hoàn SYSTEM 100% số THỰC NHẬN, 1 late-payment-credited', async () => {
    const o = await newOrder(2_000, 'CANCELLED');
    const before = await balance();
    const reference = ref();

    expect(
      (await post(await webhook({ orderCode: o.orderCode, amount: 2_500, reference }))).status,
    ).toBe(200);

    expect((await events(reference))[0].result).toBe('LATE');
    expect((await order(o.id)).status).toBe('CANCELLED'); // order không đổi
    const [lp] = await late(o.depositId);
    const [rf] = await refunds(o.depositId);
    expect(rf).toMatchObject({
      requester_type: 'SYSTEM',
      amount_vnd: '2500',
      status: 'PENDING_ADMIN',
      tenant_id: o.tenantId,
    });
    expect(lp).toMatchObject({
      order_id: o.id,
      amount_vnd: '2500',
      payos_reference: reference,
      refund_request_id: rf.id,
    });
    const tx = await walletTx(o.depositId);
    expect(tx).toHaveLength(1);
    expect(tx[0]).toMatchObject({
      type: 'LATE_PAYMENT_IN',
      amount_vnd: '2500',
      ref_type: 'LATE_PAYMENT',
      ref_id: lp.id,
    });
    expect(await balance()).toBe(before + 2_500);
    const [ev] = await outbox('payment.late-payment-credited', o.depositId);
    expectEventMatchesContract(ev); // test 11
    expect(ev.payload).toEqual({
      orderId: o.id,
      depositId: o.depositId,
      tenantId: o.tenantId,
      amountVnd: 2_500,
      payosReference: reference,
    });
    expect(await outbox('payment.deposited', o.depositId)).toHaveLength(0);
  });

  it('dòng 9: order đã PAID nhận thêm tiền với reference KHÁC -> LATE, hoàn 100% lần hai', async () => {
    const o = await newOrder();
    await post(await webhook({ orderCode: o.orderCode, amount: 2_000, reference: ref() }));
    const second = ref();

    await post(await webhook({ orderCode: o.orderCode, amount: 2_000, reference: second }));

    expect((await events(second))[0].result).toBe('LATE');
    expect(await late(o.depositId)).toHaveLength(1);
    expect((await walletTx(o.depositId)).map((x) => x.type).sort()).toEqual([
      'DEPOSIT_IN',
      'LATE_PAYMENT_IN',
    ]);
  });

  it('test 10: hủy order (hết hạn giữ chỗ) và webhook ĐUA nhau -> mỗi lần đúng MỘT bên thắng, tiền không mất, không cộng hai lần', async () => {
    for (let i = 0; i < 8; i++) {
      const o = await newOrder();
      const body = await webhook({ orderCode: o.orderCode, amount: 2_000, reference: ref() });
      const [hook, cancel] = await Promise.all([
        post(body),
        t.http().post(`/internal/payment-orders/${o.depositId}/cancel`),
      ]);
      expect(hook.status).toBe(200);
      const final = await order(o.id);
      const [ev] = await events(body.data.reference as string);
      if (final.status === 'PAID') {
        // webhook thắng: hủy nhận 409, rental không EXPIRED
        expect(cancel.status).toBe(409);
        expect(cancel.body.error.code).toBe('PAYMENT_ORDER_ALREADY_PAID');
        expect(ev.result).toBe('PAID');
        expect(await late(o.depositId)).toHaveLength(0);
      } else {
        // hủy thắng: tiền vẫn được ghi nhận như tiền đến muộn
        expect(final.status).toBe('CANCELLED');
        expect(cancel.status).toBe(200);
        expect(ev.result).toBe('LATE');
        expect(await late(o.depositId)).toHaveLength(1);
      }
      expect(await walletTx(o.depositId)).toHaveLength(1);
    }
  });

  it.each([
    ['không có order theo orderCode', 'UNKNOWN_ORDER'],
    ['webhook thử của payOS khi khai URL (orderCode 123)', 'UNKNOWN_ORDER'],
  ])('%s -> 200, %s', async (_, result) => {
    const body = await webhook({
      orderCode: _.includes('123') ? 123 : 987654321,
      amount: 3_000,
      reference: ref(),
    });
    const res = await post(body);
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ received: true });
    expect((await events(body.data.reference as string))[0].result).toBe(result);
  });

  it('success = false -> 200, IGNORED; route công khai không cần token', async () => {
    const body = await webhook(
      { orderCode: 123, amount: 3_000, reference: ref() },
      { success: false },
    );
    const res = await post(body);
    expect(res.status).toBe(200);
    expect((await events(body.data.reference as string))[0].result).toBe('IGNORED');
  });

  it('số truy vấn: PAID 7, LATE 8 (ngưỡng ghi có tiền 8, Processing_Flow §6)', async () => {
    const o = await newOrder();
    expect(
      await countQueries(async () =>
        post(await webhook({ orderCode: o.orderCode, amount: 2_000, reference: ref() })),
      ),
    ).toBe(7);
    const c = await newOrder(2_000, 'CANCELLED');
    expect(
      await countQueries(async () =>
        post(await webhook({ orderCode: c.orderCode, amount: 2_000, reference: ref() })),
      ),
    ).toBe(8);
  });
});
