/**
 * Bộ dựng dùng chung cho test unit của payout (KHÔNG phải code production; chỉ file `*.spec.ts` import).
 * `fakeDb`: định tuyến `query(sql)` theo regex tới hàm trả dòng giả, ghi lại mọi truy vấn để đếm và kiểm tham số.
 */
import { QueryFailedError } from 'typeorm';

export interface SeenQuery {
  sql: string;
  params: unknown[];
}
export type Route = [RegExp, (params: unknown[]) => unknown];

export function fakeDb(routes: Route[]) {
  const calls: SeenQuery[] = [];
  const query = jest.fn(async (sql: string, params: unknown[] = []) => {
    const s = sql.replace(/\s+/g, ' ').trim();
    calls.push({ sql: s, params });
    for (const [re, fn] of routes) if (re.test(s)) return fn(params);
    throw new Error(`SQL không mong đợi trong test: ${s}`);
  });
  const m = { query, queryRunner: { isTransactionActive: true } };
  const dataSource = { query, transaction: jest.fn(async (cb: (mm: unknown) => unknown) => cb(m)) };
  return { dataSource, m, calls, query };
}

export function uniqueViolation(constraint: string): QueryFailedError {
  return new QueryFailedError('INSERT', [], { code: '23505', constraint } as never);
}

export function deps() {
  return {
    wallet: { debit: jest.fn().mockResolvedValue(undefined) },
    audit: { log: jest.fn().mockResolvedValue(undefined) },
    outbox: { add: jest.fn().mockResolvedValue(undefined) },
    receipts: {
      store: jest
        .fn()
        .mockResolvedValue({ sha256: 'a'.repeat(64), key: `receipts/${'a'.repeat(64)}.png` }),
    },
  };
}

export const IDS = {
  deposit: '11111111-1111-4111-8111-111111111111',
  order: '22222222-2222-4222-8222-222222222222',
  tenant: '33333333-3333-4333-8333-333333333333',
  owner: '44444444-4444-4444-8444-444444444444',
  payout: '55555555-5555-4555-8555-555555555555',
  admin: '66666666-6666-4666-8666-666666666666',
  receipt: '77777777-7777-4777-8777-777777777777',
};

export const CREATED = new Date('2026-11-25T10:00:00.000Z');
export const FILE = { buffer: Buffer.from('x'), mimetype: 'image/png', size: 1 };
