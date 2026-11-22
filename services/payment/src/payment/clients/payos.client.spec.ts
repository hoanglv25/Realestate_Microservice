import { APIError, ConnectionTimeoutError, PayOS } from '@payos/node';
import { NodeCryptoProvider } from '@payos/node/lib/crypto/node-crypto';
import { PayosClient } from './payos.client';

const CONFIG = {
  returnUrl: 'http://localhost:3000/payment/return',
  cancelUrl: 'http://localhost:3000/payment/cancel',
};
const LINK = {
  bin: '970422',
  accountNumber: '0123',
  accountName: 'X',
  amount: 3_000_000,
  description: 'DC100001',
  orderCode: 100001,
  currency: 'VND',
  paymentLinkId: 'link-1',
  status: 'PENDING',
  checkoutUrl: 'https://pay.payos.vn/web/link-1',
  qrCode: '000201...',
};

const CHECKSUM_KEY = 'checksum-key-chi-de-test';

function setup() {
  const requests = {
    create: jest.fn().mockResolvedValue(LINK),
    cancel: jest.fn().mockResolvedValue({ id: 'link-1', status: 'CANCELLED' }),
  };
  const logger = { setContext: jest.fn(), warn: jest.fn(), error: jest.fn(), info: jest.fn() };
  const webhooks = new PayOS({ clientId: 'c', apiKey: 'a', checksumKey: CHECKSUM_KEY }).webhooks;
  const client = new PayosClient(requests, CONFIG, logger as never, webhooks);
  return { client, requests, logger };
}

const codeOf = (p: Promise<unknown>) =>
  p.then(
    () => 'khong-loi',
    (e: { code?: string; status?: number }) => `${e.status} ${e.code}`,
  );

describe('PayosClient.createLink', () => {
  const input = {
    orderCode: 100001,
    amountVnd: 3_000_000,
    listingTitle: 'Phòng 25m2 gần ĐH Bách Khoa',
    expiresAt: new Date('2026-11-20T08:10:00.500Z'),
  };

  it('gửi orderCode, amount, description ≤ 25 ký tự, returnUrl/cancelUrl, expiredAt (giây), items; KHÔNG retry', async () => {
    const { client, requests } = setup();
    const link = await client.createLink(input);

    expect(link).toEqual({
      paymentLinkId: 'link-1',
      checkoutUrl: 'https://pay.payos.vn/web/link-1',
      qrCode: '000201...',
    });
    expect(requests.create).toHaveBeenCalledTimes(1);
    const [body, options] = requests.create.mock.calls[0];
    expect(body).toEqual({
      orderCode: 100001,
      amount: 3_000_000,
      description: 'DC100001',
      returnUrl: CONFIG.returnUrl,
      cancelUrl: CONFIG.cancelUrl,
      expiredAt: Math.floor(input.expiresAt.getTime() / 1000),
      items: [{ name: input.listingTitle, quantity: 1, price: 3_000_000 }],
    });
    expect(body.description.length).toBeLessThanOrEqual(25);
    expect(options).toEqual({ maxRetries: 0 }); // reliability-standard: không retry tạo link
  });

  it('không có tiêu đề: item dùng tên chung', async () => {
    const { client, requests } = setup();
    await client.createLink({ ...input, listingTitle: null });
    expect(requests.create.mock.calls[0][0].items).toEqual([
      { name: 'Đặt cọc', quantity: 1, price: 3_000_000 },
    ]);
  });

  it.each([
    ['timeout', new ConnectionTimeoutError()],
    ['payOS 5xx', new APIError(502, { code: '99' }, 'bad gateway', new Headers())],
    ['payOS từ chối (code ≠ 00)', new APIError(200, { code: '231' }, 'exists', new Headers())],
    ['lỗi lạ', new Error('boom')],
  ])(
    '%s -> 503 PAYMENT_PROVIDER_UNAVAILABLE, log warn không chứa khóa hay lỗi gốc',
    async (_, err) => {
      const { client, requests, logger } = setup();
      requests.create.mockRejectedValue(err);

      expect(await codeOf(client.createLink(input))).toBe('503 PAYMENT_PROVIDER_UNAVAILABLE');
      expect(logger.warn).toHaveBeenCalledTimes(1);
      const [fields] = logger.warn.mock.calls[0];
      expect(fields).toMatchObject({ op: 'createLink', orderCode: 100001 });
      expect(JSON.stringify(fields)).not.toMatch(/exists|bad gateway|boom/);
    },
  );
});

describe('PayosClient.cancelLink', () => {
  it('hủy theo orderCode, dùng retry mặc định của client (hủy idempotent)', async () => {
    const { client, requests } = setup();
    await client.cancelLink(100001);
    expect(requests.cancel).toHaveBeenCalledWith(100001, 'Hết hạn giữ chỗ hoặc hủy đơn');
  });

  it('payOS lỗi -> 503 PAYMENT_PROVIDER_UNAVAILABLE', async () => {
    const { client, requests, logger } = setup();
    requests.cancel.mockRejectedValue(new ConnectionTimeoutError());
    expect(await codeOf(client.cancelLink(100001))).toBe('503 PAYMENT_PROVIDER_UNAVAILABLE');
    expect(logger.warn.mock.calls[0][0]).toMatchObject({ op: 'cancelLink', orderCode: 100001 });
  });
});

describe('PayosClient.verify (chữ ký webhook, SDK thật)', () => {
  const data = {
    orderCode: 100001,
    amount: 3_000_000,
    description: 'DC100001',
    accountNumber: '4025072005',
    reference: 'FT25326000001',
    transactionDateTime: '2026-11-22 22:40:00',
    currency: 'VND',
    paymentLinkId: 'link-1',
    code: '00',
    desc: 'success',
  };
  const signed = async (d: object, key = CHECKSUM_KEY) => ({
    code: '00',
    desc: 'success',
    success: true,
    data: d,
    signature: await new NodeCryptoProvider().createSignatureFromObj(d, key),
  });

  it('chữ ký đúng (ký bằng PAYOS_CHECKSUM_KEY) -> true', async () => {
    const { client } = setup();
    expect(await client.verify(await signed(data))).toBe(true);
  });

  it('chữ ký bằng khóa khác -> false, log warn chỉ có lý do, không có body', async () => {
    const { client, logger } = setup();
    expect(await client.verify(await signed(data, 'khoa-khac'))).toBe(false);
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(logger.warn.mock.calls[0])).not.toMatch(/4025072005|FT25326000001/);
  });

  it('data bị sửa sau khi ký (số tiền) -> false', async () => {
    const { client } = setup();
    const body = await signed(data);
    expect(await client.verify({ ...body, data: { ...data, amount: 1 } })).toBe(false);
  });

  it.each([
    ['không phải object', 'abc'],
    ['null', null],
    ['thiếu data', { code: '00', signature: 'x' }],
    ['thiếu signature', { code: '00', data }],
  ])('body hỏng (%s) -> false, không ném lỗi', async (_, raw) => {
    const { client } = setup();
    expect(await client.verify(raw)).toBe(false);
  });
});
