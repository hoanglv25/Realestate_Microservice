import { HttpStatus } from '@nestjs/common';
import { IsNull, LessThan, Not } from 'typeorm';
import { AppException } from '../../common/errors/app.exception';
import { Deposit } from '../entities/deposit.entity';
import { SagaLog } from '../entities/saga-log.entity';
import { SagaReconcileJob } from './saga-reconcile.job';

const NOW = new Date('2026-11-22T16:00:00.000Z');
const stuck = (n: number) => ({
  id: `0000000${n}-0000-4000-8000-000000000000`,
  listingId: `1000000${n}-0000-4000-8000-000000000000`,
  tenantId: '33333333-3333-4333-8333-333333333333',
  ownerId: '44444444-4444-4444-8444-444444444444',
  status: 'PENDING_PAYMENT',
  paymentOrderId: null,
});
const unsynced = (n: number, target = 'AVAILABLE') => ({
  id: `2000000${n}-0000-4000-8000-000000000000`,
  listingId: `3000000${n}-0000-4000-8000-000000000000`,
  listingTargetStatus: target,
});
const ORDER = {
  orderId: '55555555-5555-4555-8555-555555555555',
  depositId: stuck(1).id,
  status: 'PENDING',
  amountVnd: 2000,
  payosOrderCode: 100001,
  checkoutUrl: 'https://pay.payos.vn/web/x',
  expiresAt: NOW.toISOString(),
  paidAt: null,
};
const notFound = () =>
  new AppException('PAYMENT_ORDER_NOT_FOUND', 'Không có', HttpStatus.NOT_FOUND);

function setup(
  opts: { stuck?: unknown[]; unsynced?: unknown[]; refunds?: unknown[]; intervalMs?: number } = {},
) {
  const deposits = {
    find: jest
      .fn()
      .mockResolvedValueOnce(opts.stuck ?? [])
      .mockResolvedValueOnce(opts.unsynced ?? [])
      .mockResolvedValueOnce(opts.refunds ?? []),
    update: jest.fn().mockResolvedValue({ affected: 1 }),
  };
  const m = {
    update: jest.fn().mockResolvedValue({ affected: 1 }),
    insert: jest.fn().mockResolvedValue({}),
  };
  const dataSource = {
    transaction: jest.fn(async (cb: (mm: typeof m) => Promise<unknown>) => cb(m)),
  };
  const payment = {
    getOrder: jest.fn().mockResolvedValue(ORDER),
    createRefund: jest.fn().mockResolvedValue({ refundRequestId: 'r1' }),
  };
  const compensation = { cancelAfterHold: jest.fn().mockResolvedValue(true) };
  const sync = { push: jest.fn().mockResolvedValue('SYNCED') };
  const scheduler = {
    addInterval: jest.fn(),
    deleteInterval: jest.fn(),
    doesExist: jest.fn().mockReturnValue(true),
  };
  const logger = { warn: jest.fn(), log: jest.fn() };
  const job = new SagaReconcileJob(
    deposits as never,
    dataSource as never,
    payment as never,
    compensation as never,
    sync as never,
    scheduler as never,
    { intervalMs: opts.intervalMs ?? 15000, stuckAfterSeconds: 30 },
  );
  (job as unknown as { logger: typeof logger }).logger = logger;
  return { job, deposits, m, dataSource, payment, compensation, sync, scheduler, logger };
}

beforeAll(() => jest.useFakeTimers({ now: NOW, doNotFake: ['nextTick', 'setImmediate'] }));
afterAll(() => jest.useRealTimers());

describe('SagaReconcileJob (RE.DEPOSIT_SAGA/Component_Class_Design.md §7)', () => {
  it('(a) chọn PENDING_PAYMENT chưa có order, quá SAGA_STUCK_AFTER_SECONDS, cũ nhất trước, tối đa 50; (b) chọn đích chưa đồng bộ, tối đa 50', async () => {
    const { job, deposits } = setup();
    await job.runOnce();
    expect(deposits.find).toHaveBeenNthCalledWith(1, {
      where: {
        status: 'PENDING_PAYMENT',
        paymentOrderId: IsNull(),
        createdAt: LessThan(new Date(NOW.getTime() - 30_000)),
      },
      order: { createdAt: 'ASC' },
      take: 50,
    });
    expect(deposits.find).toHaveBeenNthCalledWith(2, {
      where: { listingTargetStatus: Not(IsNull()), listingSyncedAt: IsNull() },
      order: { updatedAt: 'ASC' },
      take: 50,
    });
  });

  it('test 7: (a) payment CÓ order -> gắn payment_order_id, checkout_url (chỉ khi còn trống) + saga_log CREATE_PAYMENT_ORDER OK, một transaction; không bù trừ', async () => {
    const { job, m, payment, compensation } = setup({ stuck: [stuck(1)] });
    const r = await job.runOnce();
    expect(payment.getOrder).toHaveBeenCalledWith(stuck(1).id);
    expect(m.update).toHaveBeenCalledWith(
      Deposit,
      { id: stuck(1).id, paymentOrderId: IsNull() },
      { paymentOrderId: ORDER.orderId, checkoutUrl: ORDER.checkoutUrl },
    );
    expect(m.insert).toHaveBeenCalledWith(
      SagaLog,
      expect.objectContaining({
        depositId: stuck(1).id,
        step: 'CREATE_PAYMENT_ORDER',
        outcome: 'OK',
      }),
    );
    expect(compensation.cancelAfterHold).not.toHaveBeenCalled();
    expect(r).toMatchObject({ attached: 1, cancelled: 0 });
  });

  it('test 8 (E8): (a) payment 404 PAYMENT_ORDER_NOT_FOUND -> bù trừ (CANCELLED, lý do PAYMENT_ORDER_NOT_FOUND, tin về AVAILABLE)', async () => {
    const { job, payment, compensation } = setup({ stuck: [stuck(1)] });
    payment.getOrder.mockRejectedValueOnce(notFound());
    const r = await job.runOnce();
    expect(compensation.cancelAfterHold).toHaveBeenCalledWith(stuck(1), {
      step: 'CREATE_PAYMENT_ORDER',
      outcome: 'BUSINESS_ERROR',
      detail: { code: 'PAYMENT_ORDER_NOT_FOUND', status: 404 },
      reason: 'PAYMENT_ORDER_NOT_FOUND',
    });
    expect(r).toMatchObject({ cancelled: 1 });
  });

  it('(a) payment lỗi tạm (503) -> không làm gì, log warn, lượt sau thử lại; đơn khác vẫn được xử lý', async () => {
    const { job, payment, m, compensation, logger } = setup({ stuck: [stuck(1), stuck(2)] });
    payment.getOrder
      .mockRejectedValueOnce(new AppException('DEPENDENCY_UNAVAILABLE', 'x', 503))
      .mockResolvedValueOnce({ ...ORDER, depositId: stuck(2).id });
    const r = await job.runOnce();
    expect(compensation.cancelAfterHold).not.toHaveBeenCalled();
    expect(m.update).toHaveBeenCalledTimes(1);
    expect(logger.warn).toHaveBeenCalled();
    expect(r).toMatchObject({ attached: 1, failed: 1 });
  });

  it('test 17: (b) đẩy từng đơn qua ListingSyncService; một đơn lỗi bất ngờ không chặn đơn khác', async () => {
    const { job, sync } = setup({ unsynced: [unsynced(1), unsynced(2, 'DEPOSITED'), unsynced(3)] });
    sync.push
      .mockResolvedValueOnce('RETRY')
      .mockRejectedValueOnce(new Error('db'))
      .mockResolvedValueOnce('SYNCED');
    const r = await job.runOnce();
    expect(sync.push).toHaveBeenCalledTimes(3);
    expect(sync.push).toHaveBeenNthCalledWith(2, unsynced(2, 'DEPOSITED'));
    expect(r).toMatchObject({ synced: 1, retry: 1, failed: 1 });
  });

  it('B6: đăng ký interval theo SAGA_RECONCILE_INTERVAL_MS lúc khởi động; 0 -> không đăng ký (tắt)', () => {
    const on = setup({ intervalMs: 15000 });
    on.job.onApplicationBootstrap();
    expect(on.scheduler.addInterval).toHaveBeenCalledWith('saga-reconcile', expect.anything());
    on.job.onApplicationShutdown();
    expect(on.scheduler.deleteInterval).toHaveBeenCalledWith('saga-reconcile');
    on.scheduler.doesExist.mockReturnValue(false); // ScheduleModule đã dọn trước
    on.scheduler.deleteInterval.mockClear();
    on.job.onApplicationShutdown();
    expect(on.scheduler.deleteInterval).not.toHaveBeenCalled();

    const off = setup({ intervalMs: 0 });
    off.job.onApplicationBootstrap();
    expect(off.scheduler.addInterval).not.toHaveBeenCalled();
  });

  it('B6: lượt trước chưa xong thì bỏ lượt mới (không chạy chồng)', async () => {
    const { job, deposits } = setup();
    let release!: () => void;
    deposits.find.mockReset().mockImplementation(() => new Promise((r) => (release = () => r([]))));
    const first = job.tick();
    await job.tick(); // bỏ qua
    expect(deposits.find).toHaveBeenCalledTimes(1);
    // runOnce có 3 lượt find: (a), (b), (c) (T3.5)
    release();
    await Promise.resolve();
    release();
    await Promise.resolve();
    release();
    await first;
  });

  describe('(c) gửi lại yêu cầu hoàn chưa tới payment (RE.DEPOSIT_LIFECYCLE test 4, chốt T3.5 B4)', () => {
    const refund = (n: number) => ({
      id: `4000000${n}-0000-4000-8000-000000000000`,
      status: 'REFUND_REQUESTED',
      refundSyncedAt: null,
    });

    it('chọn REFUND_REQUESTED chưa đánh dấu refund_synced_at, cũ nhất trước, tối đa 50', async () => {
      const { job, deposits } = setup();
      await job.runOnce();
      expect(deposits.find).toHaveBeenNthCalledWith(3, {
        where: { status: 'REFUND_REQUESTED', refundSyncedAt: IsNull() },
        order: { updatedAt: 'ASC' },
        take: 50,
      });
    });

    it('payment nhận -> đánh dấu refund_synced_at (chỉ khi còn trống)', async () => {
      const { job, deposits, payment } = setup({ refunds: [refund(1)] });
      await expect(job.runOnce()).resolves.toMatchObject({ refundSent: 1, refundRetry: 0 });
      expect(payment.createRefund).toHaveBeenCalledWith({ depositId: refund(1).id });
      expect(deposits.update).toHaveBeenCalledWith(
        { id: refund(1).id, refundSyncedAt: IsNull() },
        { refundSyncedAt: NOW },
      );
    });

    it('payment lỗi (mọi loại, kể cả 4xx) -> không đánh dấu, log warn, lượt sau gửi lại; đơn khác vẫn chạy', async () => {
      const { job, deposits, payment, logger } = setup({ refunds: [refund(1), refund(2)] });
      payment.createRefund.mockRejectedValueOnce(notFound());
      await expect(job.runOnce()).resolves.toMatchObject({ refundSent: 1, refundRetry: 1 });
      expect(deposits.update).toHaveBeenCalledTimes(1);
      expect(deposits.update).toHaveBeenCalledWith(
        { id: refund(2).id, refundSyncedAt: IsNull() },
        expect.anything(),
      );
      expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining(refund(1).id));
    });
  });
});
