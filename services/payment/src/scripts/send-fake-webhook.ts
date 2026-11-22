import { NodeCryptoProvider } from '@payos/node/lib/crypto/node-crypto';
import { existsSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';

/**
 * `pnpm --filter @realestate/payment webhook:fake -- --order-code <n> --amount <vnd> [tùy chọn]`
 *
 * Gửi một webhook payOS GIẢ có chữ ký hợp lệ (ký `data` bằng `PAYOS_CHECKSUM_KEY` đúng thuật toán của SDK
 * `@payos/node`) tới gateway, để kiểm chứng các nhánh của `RE.PAYMENT/API_Spec.md §1` mà không cần trả tiền thật:
 * hợp lệ, trùng (`--reference` cũ), sai chữ ký (`--bad-signature`), sai số tiền (`--amount` khác), đến muộn (order đã
 * hủy), `success=false` (`--failed`). Dự phòng khi đường hầm/payOS lỗi lúc demo (`RE_Report_Defense_Guide.md`).
 *
 * Tùy chọn: `--reference <mã>` (mặc định FAKE<thời gian>), `--date "YYYY-MM-DD HH:mm:ss"` (giờ VN, mặc định bây
 * giờ), `--url <url webhook>` (mặc định gateway local), `--bad-signature`, `--failed`.
 *
 * Khóa: `PAYOS_CHECKSUM_KEY` trong môi trường, hoặc `.env` của service, hoặc `.env` gốc repo. Không in khóa.
 * Gửi bằng `node:http`/`node:https`: đây là công cụ dev, không phải lời gọi giữa các service (A duyệt 2026-11-22).
 */

const DEFAULT_URL = 'http://localhost:8080/api/v1/payments/payos/webhook';
const DATETIME = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/;

export interface FakeWebhookInput {
  orderCode: number;
  amount: number;
  reference: string;
  transactionDateTime: string;
  badSignature?: boolean;
  failed?: boolean;
}

export interface FakeArgs extends FakeWebhookInput {
  url: string;
  badSignature: boolean;
  failed: boolean;
}

/** Giờ Việt Nam (+07:00) dạng payOS `YYYY-MM-DD HH:mm:ss`. */
export function vnNow(now: Date = new Date()): string {
  return new Date(now.getTime() + 7 * 3_600_000).toISOString().slice(0, 19).replace('T', ' ');
}

/** Body giống payOS gửi (`Webhook` của SDK), ký `data` bằng `key`. `badSignature`: ký bằng khóa khác. */
export async function buildFakeWebhook(input: FakeWebhookInput, key: string) {
  const data = {
    orderCode: input.orderCode,
    amount: input.amount,
    description: `DC${input.orderCode}`,
    accountNumber: '0000000000',
    reference: input.reference,
    transactionDateTime: input.transactionDateTime,
    currency: 'VND',
    paymentLinkId: 'fake-payment-link',
    code: input.failed ? '01' : '00',
    desc: input.failed ? 'failed' : 'success',
    counterAccountBankId: '',
    counterAccountBankName: '',
    counterAccountName: 'WEBHOOK GIA',
    counterAccountNumber: '',
    virtualAccountName: '',
    virtualAccountNumber: '',
  };
  const signature = await new NodeCryptoProvider().createSignatureFromObj(
    data,
    input.badSignature ? `${key}-sai` : key,
  );
  return {
    code: input.failed ? '01' : '00',
    desc: input.failed ? 'failed' : 'success',
    success: !input.failed,
    data,
    signature: signature ?? '',
  };
}

export function parseArgs(argv: string[]): FakeArgs {
  const get = (name: string): string | undefined => {
    const i = argv.indexOf(name);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const positive = (name: string): number => {
    const v = Number(get(name));
    if (!Number.isSafeInteger(v) || v <= 0) throw new Error(`${name} phải là số nguyên dương`);
    return v;
  };
  const date = get('--date') ?? vnNow();
  if (!DATETIME.test(date)) throw new Error('--date phải có dạng "YYYY-MM-DD HH:mm:ss" (giờ VN)');
  return {
    orderCode: positive('--order-code'),
    amount: positive('--amount'),
    reference: get('--reference') ?? `FAKE${Date.now()}`,
    transactionDateTime: date,
    url: get('--url') ?? DEFAULT_URL,
    badSignature: argv.includes('--bad-signature'),
    failed: argv.includes('--failed'),
  };
}

function loadChecksumKey(): string {
  for (const file of ['.env', '../../.env']) {
    if (!process.env.PAYOS_CHECKSUM_KEY && existsSync(file)) process.loadEnvFile(file); // không ghi đè biến có sẵn
  }
  const key = process.env.PAYOS_CHECKSUM_KEY?.trim();
  if (!key)
    throw new Error('Thiếu PAYOS_CHECKSUM_KEY (môi trường, services/payment/.env hoặc .env gốc)');
  return key;
}

function send(url: string, body: unknown): Promise<{ status: number; text: string }> {
  const payload = Buffer.from(JSON.stringify(body));
  const target = new URL(url);
  const request = target.protocol === 'https:' ? httpsRequest : httpRequest;
  return new Promise((resolve, reject) => {
    const req = request(
      target,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'content-length': payload.length },
        timeout: 10_000,
      },
      (res) => {
        let text = '';
        res.setEncoding('utf8');
        res.on('data', (c: string) => (text += c));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, text }));
      },
    );
    req.on('timeout', () => req.destroy(new Error('Quá 10 giây không phản hồi')));
    req.on('error', reject);
    req.end(payload);
  });
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const body = await buildFakeWebhook(args, loadChecksumKey());
  console.log(
    `Gửi webhook giả: orderCode=${args.orderCode} amount=${args.amount} reference=${args.reference} ` +
      `time="${args.transactionDateTime}"${args.badSignature ? ' [SAI CHỮ KÝ]' : ''}${args.failed ? ' [success=false]' : ''}`,
  );
  const res = await send(args.url, body);
  console.log(`-> HTTP ${res.status} ${res.text}`);
  console.log('Kết quả xử lý: xem payos_webhook_events.result theo reference ở trên.');
  if (res.status >= 400) process.exitCode = 1;
}

if (require.main === module) {
  main().catch((err: unknown) => {
    console.error(
      `Không gửi được webhook giả: ${err instanceof Error ? err.message : String(err)}`,
    );
    process.exitCode = 1;
  });
}
