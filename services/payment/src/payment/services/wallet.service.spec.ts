import { WalletService } from './wallet.service';

function manager() {
  const calls: Array<{ sql: string; params: unknown[] }> = [];
  const m = {
    query: jest.fn(async (sql: string, params: unknown[] = []) => {
      calls.push({ sql: sql.replace(/\s+/g, ' ').trim(), params });
      return [];
    }),
  };
  return { m, calls };
}

const DEPOSIT = '11111111-1111-4111-8111-111111111111';
const ORDER = '22222222-2222-4222-8222-222222222222';
const TENANT = '33333333-3333-4333-8333-333333333333';
const OWNER = '44444444-4444-4444-8444-444444444444';

describe('WalletService.credit (RE.PAYOUT DDL ví)', () => {
  it('ghi một dòng wallet_transactions RỒI cộng admin_wallet.balance_vnd bằng đúng số tiền: 2 truy vấn, cùng manager', async () => {
    const { m, calls } = manager();
    await new WalletService().credit(m as never, {
      type: 'DEPOSIT_IN',
      amountVnd: 3_000_000,
      depositId: DEPOSIT,
      refType: 'ORDER',
      refId: ORDER,
      tenantId: TENANT,
      ownerId: OWNER,
    });

    expect(calls).toHaveLength(2);
    expect(calls[0].sql).toMatch(/^INSERT INTO wallet_transactions/);
    expect(calls[0].params).toEqual([
      'DEPOSIT_IN',
      3_000_000,
      DEPOSIT,
      'ORDER',
      ORDER,
      TENANT,
      OWNER,
      null, // correlation_id: ngoài request (test) không có
    ]);
    expect(calls[1].sql).toMatch(
      /^UPDATE admin_wallet SET balance_vnd = balance_vnd \+ \$1, updated_at = now\(\) WHERE id = 1$/,
    );
    expect(calls[1].params).toEqual([3_000_000]);
  });

  it('tiền đến muộn: type LATE_PAYMENT_IN, ref LATE_PAYMENT, không có chủ trọ (owner_id null)', async () => {
    const { m, calls } = manager();
    await new WalletService().credit(m as never, {
      type: 'LATE_PAYMENT_IN',
      amountVnd: 2_000,
      depositId: DEPOSIT,
      refType: 'LATE_PAYMENT',
      refId: ORDER,
      tenantId: TENANT,
      ownerId: null,
    });
    expect(calls[0].params).toEqual([
      'LATE_PAYMENT_IN',
      2_000,
      DEPOSIT,
      'LATE_PAYMENT',
      ORDER,
      TENANT,
      null,
      null,
    ]);
    expect(calls[1].params).toEqual([2_000]);
  });
});
