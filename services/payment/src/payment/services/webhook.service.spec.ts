import { QueryFailedError } from 'typeorm';
import type { PaymentOrder } from '../entities/payment-order.entity';
import { WebhookService } from './webhook.service';

const EVENT_ID = '99999999-9999-4999-8999-999999999999';
const ORDER: PaymentOrder = {
  id: '22222222-2222-4222-8222-222222222222',
  depositId: '11111111-1111-4111-8111-111111111111',
  tenantId: '33333333-3333-4333-8333-333333333333',
  ownerId: '44444444-4444-4444-8444-444444444444',
  listingTitle: 'Phòng test',
  amountVnd: 3_000_000,
  payosOrderCode: 100001,
  payosPaymentLinkId: 'link-1',
  checkoutUrl: 'https://pay.payos.vn/web/link-1',
  qrCode: '000201',
  status: 'PENDING',
  payosReference: null,
  expiresAt: new Date('2026-11-22T15:27:11.493Z'),
  paidAt: null,
  cancelledAt: null,
  createdAt: new Date(),
  updatedAt: new Date(),
};

const body = (over: Record<string, unknown> = {}, data: Record<string, unknown> = {}) => ({
  code: '00',
  desc: 'success',
  success: true,
  signature: 'sig',
  ...over,
  data: {
    orderCode: 100001,
    amount: 3_000_000,
    description: 'DC100001',
    accountNumber: '4025072005',
    reference: 'FT25326000001',
    transactionDateTime: '2026-11-22 22:20:00',
    currency: 'VND',
    paymentLinkId: 'link-1',
    code: '00',
    desc: 'success',
    ...data,
  },
});

const duplicate = () =>
  new QueryFailedError('UPDATE payos_webhook_events', [], {
    code: '23505',
    constraint: 'ux_webhook_accepted_reference',
  } as unknown as Error);

function setup(opts: { valid?: boolean; order?: PaymentOrder | null; captured?: boolean } = {}) {
  const { valid = true, order = ORDER, captured = true } = opts;
  const sql: Array<{ sql: string; params: unknown[] }> = [];
  const txSql: Array<{ sql: string; params: unknown[] }> = [];
  const norm = (s: string) => s.replace(/\s+/g, ' ').trim();
  const m = {
    query: jest.fn(async (s: string, p: unknown[] = []) => {
      txSql.push({ sql: norm(s), params: p });
      return [];
    }),
  };
  const dataSource = {
    query: jest.fn(async (s: string, p: unknown[] = []) => {
      sql.push({ sql: norm(s), params: p });
      return /^INSERT/.test(norm(s)) ? [{ id: EVENT_ID }] : [];
    }),
    transaction: jest.fn(async (cb: (mm: typeof m) => Promise<unknown>) => cb(m)),
  };
  const orders = { findOneBy: jest.fn(async () => order) };
  const payos = { verify: jest.fn(async () => valid) };
  const capture = {
    capture: jest.fn(async () => captured),
    recordLate: jest.fn(async () => undefined),
  };
  const logger = { setContext: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() };
  const service = new WebhookService(
    dataSource as never,
    orders as never,
    payos as never,
    capture as never,
    logger as never,
  );
  return { service, dataSource, orders, payos, capture, logger, sql, txSql, m };
}

const insertParams = (sql: Array<{ sql: string; params: unknown[] }>) => {
  expect(sql[0].sql).toMatch(/^INSERT INTO payos_webhook_events/);
  return sql[0].params;
};

describe('WebhookService.handle (RE.PAYMENT/API_Spec.md §1)', () => {
  it('dòng 1 + 2: luôn lưu nguyên văn TRƯỚC; sai chữ ký -> INVALID_SIGNATURE ngay khi INSERT, không đọc order, log warn', async () => {
    const { service, sql, orders, capture, logger } = setup({ valid: false });
    const raw = body();
    expect(await service.handle(raw)).toBe('INVALID_SIGNATURE');

    expect(sql).toHaveLength(1);
    expect(insertParams(sql)).toEqual([
      100001,
      'FT25326000001',
      3_000_000,
      false,
      'INVALID_SIGNATURE',
      JSON.stringify(raw),
    ]);
    expect(orders.findOneBy).not.toHaveBeenCalled();
    expect(capture.capture).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalled();
  });

  it.each([
    ['success = false', body({ success: false })],
    ["code ≠ '00'", body({ code: '01' })],
    ['thiếu reference', body({}, { reference: undefined })],
    ['amount không phải số nguyên dương', body({}, { amount: 'abc' })],
  ])('dòng 3: %s -> IGNORED, không đọc order', async (_, raw) => {
    const { service, sql, orders } = setup();
    expect(await service.handle(raw)).toBe('IGNORED');
    expect(insertParams(sql)[4]).toBe('IGNORED');
    expect(orders.findOneBy).not.toHaveBeenCalled();
  });

  it('body không phải JSON object -> vẫn lưu (cột null), INVALID_SIGNATURE, không ném lỗi', async () => {
    const { service, sql } = setup({ valid: false });
    expect(await service.handle('abc')).toBe('INVALID_SIGNATURE');
    expect(insertParams(sql)).toEqual([null, null, null, false, 'INVALID_SIGNATURE', '"abc"']);
  });

  it('reference dài hơn cột (100) -> cột reference null (nguyên văn vẫn giữ trong raw), IGNORED', async () => {
    const { service, sql } = setup();
    expect(await service.handle(body({}, { reference: 'x'.repeat(101) }))).toBe('IGNORED');
    expect(insertParams(sql)[1]).toBeNull();
  });

  it('dòng 4: không có order theo orderCode -> UNKNOWN_ORDER (UPDATE result), log warn', async () => {
    const { service, sql, orders, logger } = setup({ order: null });
    expect(await service.handle(body())).toBe('UNKNOWN_ORDER');
    expect(orders.findOneBy).toHaveBeenCalledWith({ payosOrderCode: 100001 });
    expect(sql[1]).toEqual({
      sql: 'UPDATE payos_webhook_events SET result = $2 WHERE id = $1',
      params: [EVENT_ID, 'UNKNOWN_ORDER'],
    });
    expect(logger.warn).toHaveBeenCalled();
  });

  it('dòng 5: order PENDING, sai số tiền -> AMOUNT_MISMATCH, KHÔNG mở transaction (ví không đổi)', async () => {
    const { service, sql, dataSource, capture } = setup();
    expect(await service.handle(body({}, { amount: 2_999_000 }))).toBe('AMOUNT_MISMATCH');
    expect(sql[1].params).toEqual([EVENT_ID, 'AMOUNT_MISMATCH']);
    expect(dataSource.transaction).not.toHaveBeenCalled();
    expect(capture.capture).not.toHaveBeenCalled();
  });

  it('dòng 7: order PENDING đúng số tiền -> capture TRƯỚC, rồi result=PAID trong CÙNG transaction', async () => {
    const { service, capture, txSql, m } = setup();
    expect(await service.handle(body())).toBe('PAID');
    expect(capture.capture).toHaveBeenCalledWith(m, ORDER, {
      reference: 'FT25326000001',
      amountVnd: 3_000_000,
      paidAt: new Date('2026-11-22T15:20:00.000Z'), // 22:20 giờ VN
    });
    expect(txSql).toEqual([
      {
        sql: 'UPDATE payos_webhook_events SET result = $2 WHERE id = $1',
        params: [EVENT_ID, 'PAID'],
      },
    ]);
    expect(capture.recordLate).not.toHaveBeenCalled();
  });

  it('đua: order PENDING nhưng UPDATE 0 dòng (lệnh hủy vừa thắng) -> ghi tiền đến muộn trong cùng transaction, LATE', async () => {
    const { service, capture, txSql } = setup({ captured: false });
    expect(await service.handle(body())).toBe('LATE');
    expect(txSql.map((q) => q.params[1])).toEqual(['LATE']);
    expect(capture.recordLate).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['dòng 8: order CANCELLED', 'CANCELLED'],
    ['dòng 9: order PAID, reference khác (thanh toán hai lần)', 'PAID'],
  ] as const)(
    '%s -> LATE với SỐ THỰC NHẬN (kể cả khác tiền cọc), không gọi capture',
    async (_, status) => {
      const { service, capture, txSql, m } = setup({ order: { ...ORDER, status } });
      expect(await service.handle(body({}, { amount: 2_500_000 }))).toBe('LATE');
      expect(capture.capture).not.toHaveBeenCalled();
      expect(txSql[0].params).toEqual([EVENT_ID, 'LATE']);
      expect(capture.recordLate).toHaveBeenCalledWith(
        m,
        { ...ORDER, status },
        expect.objectContaining({ amountVnd: 2_500_000 }),
      );
    },
  );

  it('dòng 6: reference đã được ghi nhận (unique ux_webhook_accepted_reference) -> rollback, DUPLICATE', async () => {
    const { service, dataSource, sql } = setup();
    dataSource.transaction.mockRejectedValueOnce(duplicate());
    expect(await service.handle(body())).toBe('DUPLICATE');
    expect(sql[sql.length - 1].params).toEqual([EVENT_ID, 'DUPLICATE']);
  });

  it('lỗi DB khác trong transaction -> ném (500) để payOS gửi lại; nguyên văn đã lưu từ trước', async () => {
    const { service, dataSource, sql } = setup();
    dataSource.transaction.mockRejectedValueOnce(new Error('connection terminated'));
    await expect(service.handle(body())).rejects.toThrow('connection terminated');
    expect(sql[0].sql).toMatch(/^INSERT INTO payos_webhook_events/);
  });

  it('transactionDateTime sai dạng -> paidAt = bây giờ, log warn (không chặn ghi nhận tiền)', async () => {
    const { service, capture, logger } = setup();
    const before = Date.now();
    expect(await service.handle(body({}, { transactionDateTime: 'hôm qua' }))).toBe('PAID');
    const paid = (capture.capture.mock.calls[0] as unknown[])[2] as { paidAt: Date };
    expect(paid.paidAt.getTime()).toBeGreaterThanOrEqual(before);
    expect(logger.warn).toHaveBeenCalled();
  });

  it('log không chứa số tài khoản hay chữ ký', async () => {
    const { service, logger } = setup({ order: null });
    await service.handle(body());
    const logged = JSON.stringify([...logger.info.mock.calls, ...logger.warn.mock.calls]);
    expect(logged).not.toMatch(/4025072005|"sig"/);
  });
});
