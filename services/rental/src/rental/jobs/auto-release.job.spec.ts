import { LessThanOrEqual } from 'typeorm';
import { Deposit } from '../entities/deposit.entity';
import { AutoReleaseJob } from './auto-release.job';

const NOW = new Date('2026-11-25T08:00:00.000Z');
const due = (n: number) => ({
  id: `0000000${n}-0000-4000-8000-000000000000`,
  listingId: `1000000${n}-0000-4000-8000-000000000000`,
  tenantId: '33333333-3333-4333-8333-333333333333',
  ownerId: '44444444-4444-4444-8444-444444444444',
  status: 'PAID',
  autoReleaseAt: new Date(NOW.getTime() - 1000),
});

function setup(opts: { due?: unknown[]; intervalMs?: number } = {}) {
  const calls: string[] = [];
  const deposits = { find: jest.fn().mockResolvedValue(opts.due ?? [due(1)]) };
  const m = { update: jest.fn().mockResolvedValue({ affected: 1 }) };
  const dataSource = {
    transaction: jest.fn(async (cb: (mm: typeof m) => Promise<unknown>) => {
      calls.push('transaction');
      return cb(m);
    }),
  };
  const outbox = { add: jest.fn().mockResolvedValue(undefined) };
  const sync = {
    push: jest.fn(async (d: { id: string }) => {
      calls.push(`push:${d.id}`);
      return 'SYNCED';
    }),
  };
  const scheduler = { addInterval: jest.fn(), deleteInterval: jest.fn(), doesExist: jest.fn() };
  const logger = { warn: jest.fn(), log: jest.fn() };
  const job = new AutoReleaseJob(
    deposits as never,
    dataSource as never,
    outbox as never,
    sync as never,
    scheduler as never,
    { intervalMs: opts.intervalMs ?? 10000 },
  );
  (job as unknown as { logger: typeof logger }).logger = logger;
  return { job, calls, deposits, m, outbox, sync, scheduler, logger };
}

beforeAll(() => jest.useFakeTimers({ now: NOW, doNotFake: ['nextTick', 'setImmediate'] }));
afterAll(() => jest.useRealTimers());

describe('AutoReleaseJob (BR-13, RE.DEPOSIT_LIFECYCLE Component_Class_Design §4)', () => {
  it('chọn PAID đã tới auto_release_at, sớm nhất trước, tối đa 50 (REFUND_REQUESTED tự bị loại)', async () => {
    const { job, deposits } = setup({ due: [] });
    await job.runOnce();
    expect(deposits.find).toHaveBeenCalledWith({
      where: { status: 'PAID', autoReleaseAt: LessThanOrEqual(NOW) },
      order: { autoReleaseAt: 'ASC' },
      take: 50,
    });
  });

  it('PAID → RELEASED trigger AUTO, đích RENTED, outbox deposit-released trong CÙNG transaction; đẩy RENTED sau commit', async () => {
    const d = due(1);
    const { job, calls, m, outbox, sync } = setup({ due: [d] });
    await expect(job.runOnce()).resolves.toMatchObject({ released: 1 });

    expect(m.update).toHaveBeenCalledWith(
      Deposit,
      { id: d.id, status: 'PAID', autoReleaseAt: LessThanOrEqual(NOW) },
      {
        status: 'RELEASED',
        releasedAt: NOW,
        releaseTrigger: 'AUTO',
        listingTargetStatus: 'RENTED',
        listingSyncedAt: null,
      },
    );
    expect(outbox.add).toHaveBeenCalledWith(m, 'rental.deposit-released', {
      depositId: d.id,
      listingId: d.listingId,
      tenantId: d.tenantId,
      ownerId: d.ownerId,
      trigger: 'AUTO',
    });
    expect(calls).toEqual(['transaction', `push:${d.id}`]);
    expect(sync.push).toHaveBeenCalledWith({
      id: d.id,
      listingId: d.listingId,
      listingTargetStatus: 'RENTED',
    });
  });

  it('test 5 (E7): UPDATE 0 dòng (người thuê vừa yêu cầu hoàn hoặc nhận phòng) -> bỏ qua: không outbox, không đẩy', async () => {
    const { job, m, outbox, sync } = setup();
    m.update.mockResolvedValueOnce({ affected: 0 });
    await expect(job.runOnce()).resolves.toMatchObject({ released: 0, skipped: 1 });
    expect(outbox.add).not.toHaveBeenCalled();
    expect(sync.push).not.toHaveBeenCalled();
  });

  it('một đơn lỗi DB không chặn đơn khác; lỗi đẩy listing không làm hỏng đơn đã RELEASED', async () => {
    const { job, m, sync, logger } = setup({ due: [due(1), due(2), due(3)] });
    m.update.mockRejectedValueOnce(new Error('db down'));
    sync.push.mockRejectedValueOnce(new Error('listing'));
    await expect(job.runOnce()).resolves.toMatchObject({ released: 2, failed: 1 });
    expect(sync.push).toHaveBeenCalledTimes(2);
    expect(logger.warn).toHaveBeenCalledTimes(2);
  });

  it('đăng ký interval "auto-release" theo AUTO_RELEASE_INTERVAL_MS; 0 -> tắt', () => {
    const on = setup({ intervalMs: 10000 });
    on.job.onApplicationBootstrap();
    expect(on.scheduler.addInterval).toHaveBeenCalledWith('auto-release', expect.anything());
    clearInterval(on.scheduler.addInterval.mock.calls[0][1] as NodeJS.Timeout);
    const off = setup({ intervalMs: 0 });
    off.job.onApplicationBootstrap();
    expect(off.scheduler.addInterval).not.toHaveBeenCalled();
  });
});
