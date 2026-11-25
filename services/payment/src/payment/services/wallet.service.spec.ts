import { QueryFailedError } from 'typeorm';
import { AppException } from '../../common/errors/app.exception';
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

const WITHDRAWAL = '55555555-5555-4555-8555-555555555555';

describe('WalletService.debit (RE.PAYOUT §1.2, T3.6)', () => {
  it('trừ admin_wallet.balance_vnd TRƯỚC rồi ghi wallet_transactions WITHDRAW_OUT: 2 truy vấn, cùng manager', async () => {
    const { m, calls } = manager();
    await new WalletService().debit(m as never, {
      type: 'WITHDRAW_OUT',
      amountVnd: 3_000_000,
      depositId: DEPOSIT,
      refType: 'WITHDRAWAL',
      refId: WITHDRAWAL,
      tenantId: null,
      ownerId: OWNER,
    });
    expect(calls).toHaveLength(2);
    expect(calls[0].sql).toMatch(
      /^UPDATE admin_wallet SET balance_vnd = balance_vnd - \$1, updated_at = now\(\) WHERE id = 1$/,
    );
    expect(calls[0].params).toEqual([3_000_000]);
    expect(calls[1].sql).toMatch(/^INSERT INTO wallet_transactions/);
    expect(calls[1].params).toEqual([
      'WITHDRAW_OUT',
      3_000_000,
      DEPOSIT,
      'WITHDRAWAL',
      WITHDRAWAL,
      null,
      OWNER,
      null,
    ]);
  });

  it('REFUND_OUT: ref REFUND, có người thuê', async () => {
    const { m, calls } = manager();
    await new WalletService().debit(m as never, {
      type: 'REFUND_OUT',
      amountVnd: 2_100_000,
      depositId: DEPOSIT,
      refType: 'REFUND',
      refId: WITHDRAWAL,
      tenantId: TENANT,
      ownerId: OWNER,
    });
    expect(calls[1].params.slice(0, 7)).toEqual([
      'REFUND_OUT',
      2_100_000,
      DEPOSIT,
      'REFUND',
      WITHDRAWAL,
      TENANT,
      OWNER,
    ]);
  });

  it('vi phạm CHECK (balance_vnd >= 0) → 409 PAYMENT_WALLET_INSUFFICIENT, log error, không ghi giao dịch', async () => {
    const checkViolation = new QueryFailedError('UPDATE admin_wallet', [], {
      code: '23514',
      constraint: 'admin_wallet_balance_vnd_check',
    } as never);
    const m = { query: jest.fn().mockRejectedValueOnce(checkViolation) };
    const logger = { error: jest.fn(), setContext: jest.fn() };
    const err = await new WalletService(logger as never)
      .debit(m as never, {
        type: 'WITHDRAW_OUT',
        amountVnd: 1,
        depositId: DEPOSIT,
        refType: 'WITHDRAWAL',
        refId: WITHDRAWAL,
        tenantId: null,
        ownerId: OWNER,
      })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AppException);
    expect((err as AppException).code).toBe('PAYMENT_WALLET_INSUFFICIENT');
    expect((err as AppException).getStatus()).toBe(409);
    expect(m.query).toHaveBeenCalledTimes(1);
    expect(logger.error).toHaveBeenCalledTimes(1);
  });

  it('lỗi DB khác chuyển nguyên', async () => {
    const other = new Error('mất kết nối');
    const m = { query: jest.fn().mockRejectedValueOnce(other) };
    await expect(
      new WalletService().debit(m as never, {
        type: 'WITHDRAW_OUT',
        amountVnd: 1,
        depositId: DEPOSIT,
        refType: 'WITHDRAWAL',
        refId: WITHDRAWAL,
        tenantId: null,
        ownerId: OWNER,
      }),
    ).rejects.toBe(other);
  });
});

describe('WalletService.invariant (E10, test 13)', () => {
  it('một truy vấn: số dư, tổng vào, tổng ra; holds = (số dư = vào − ra)', async () => {
    const m = {
      query: jest
        .fn()
        .mockResolvedValueOnce([{ balance: '900', total_in: '3000', total_out: '2100' }]),
    };
    await expect(new WalletService().invariant(m as never)).resolves.toEqual({
      balanceVnd: 900,
      totalInVnd: 3000,
      totalOutVnd: 2100,
      holds: true,
    });
    expect(m.query).toHaveBeenCalledTimes(1);
  });

  it('lệch → holds false', async () => {
    const m = {
      query: jest
        .fn()
        .mockResolvedValueOnce([{ balance: '1000', total_in: '3000', total_out: '2100' }]),
    };
    await expect(new WalletService().invariant(m as never)).resolves.toMatchObject({
      holds: false,
    });
  });
});
