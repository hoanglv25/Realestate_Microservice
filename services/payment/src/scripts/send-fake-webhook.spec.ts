import { PayOS } from '@payos/node';
import { buildFakeWebhook, parseArgs, vnNow } from './send-fake-webhook';

const KEY = 'checksum-key-chi-de-test';
const sdk = new PayOS({ clientId: 'c', apiKey: 'a', checksumKey: KEY });

describe('buildFakeWebhook', () => {
  const input = {
    orderCode: 100000,
    amount: 2_000,
    reference: 'FAKE123',
    transactionDateTime: '2026-11-22 22:40:00',
  };

  it('chữ ký tạo bằng PAYOS_CHECKSUM_KEY được webhooks.verify của SDK payOS chấp nhận; đủ trường như payOS gửi', async () => {
    const body = await buildFakeWebhook(input, KEY);
    await expect(sdk.webhooks.verify(body)).resolves.toMatchObject({
      orderCode: 100000,
      amount: 2_000,
      reference: 'FAKE123',
      transactionDateTime: '2026-11-22 22:40:00',
      description: 'DC100000',
      code: '00',
    });
    expect(body).toMatchObject({ code: '00', desc: 'success', success: true });
  });

  it('--bad-signature: SDK từ chối', async () => {
    const body = await buildFakeWebhook({ ...input, badSignature: true }, KEY);
    await expect(sdk.webhooks.verify(body)).rejects.toThrow();
  });

  it('--failed: success=false, code ≠ 00 (vẫn ký đúng)', async () => {
    const body = await buildFakeWebhook({ ...input, failed: true }, KEY);
    expect(body).toMatchObject({ success: false, code: '01' });
    await expect(sdk.webhooks.verify(body)).resolves.toBeDefined();
  });
});

describe('parseArgs', () => {
  it('đọc --order-code, --amount (bắt buộc), mặc định url gateway, reference tự sinh, giờ VN hiện tại', () => {
    const a = parseArgs(['--order-code', '100000', '--amount', '2000']);
    expect(a).toMatchObject({
      orderCode: 100000,
      amount: 2_000,
      url: 'http://localhost:8080/api/v1/payments/payos/webhook',
      badSignature: false,
      failed: false,
    });
    expect(a.reference).toMatch(/^FAKE\d+$/);
    expect(a.transactionDateTime).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
  });

  it('đọc --reference, --date, --url, --bad-signature, --failed', () => {
    expect(
      parseArgs([
        '--order-code',
        '7',
        '--amount',
        '9',
        '--reference',
        'R1',
        '--date',
        '2026-11-22 08:00:00',
        '--url',
        'https://x.trycloudflare.com/api/v1/payments/payos/webhook',
        '--bad-signature',
        '--failed',
      ]),
    ).toEqual({
      orderCode: 7,
      amount: 9,
      reference: 'R1',
      transactionDateTime: '2026-11-22 08:00:00',
      url: 'https://x.trycloudflare.com/api/v1/payments/payos/webhook',
      badSignature: true,
      failed: true,
    });
  });

  it.each([
    [[], '--order-code'],
    [['--order-code', '1'], '--amount'],
    [['--order-code', 'abc', '--amount', '1'], '--order-code'],
    [['--order-code', '1', '--amount', '0'], '--amount'],
    [['--order-code', '1', '--amount', '1', '--date', 'hom qua'], '--date'],
  ])('sai/thiếu tham số %j -> báo lỗi nêu %s', (args, name) => {
    expect(() => parseArgs(args)).toThrow(name);
  });
});

describe('vnNow', () => {
  it('giờ VN (+07:00) dạng YYYY-MM-DD HH:mm:ss', () => {
    expect(vnNow(new Date('2026-11-22T15:40:05.000Z'))).toBe('2026-11-22 22:40:05');
  });
});
