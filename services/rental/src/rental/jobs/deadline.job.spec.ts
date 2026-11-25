import { And, IsNull, LessThanOrEqual, MoreThan } from 'typeorm';
import { Deposit } from '../entities/deposit.entity';
import { DeadlineJob } from './deadline.job';

const NOW = new Date('2026-11-25T08:00:00.000Z');
const REMINDER = 86400;
const soon = (n: number) => ({
  id: `0000000${n}-0000-4000-8000-000000000000`,
  listingId: `1000000${n}-0000-4000-8000-000000000000`,
  tenantId: '33333333-3333-4333-8333-333333333333',
  ownerId: '44444444-4444-4444-8444-444444444444',
  status: 'PAID',
  autoReleaseAt: new Date(NOW.getTime() + 3600_000),
});

function setup(opts: { due?: unknown[]; intervalMs?: number } = {}) {
  const deposits = { find: jest.fn().mockResolvedValue(opts.due ?? [soon(1)]) };
  const m = { update: jest.fn().mockResolvedValue({ affected: 1 }) };
  const dataSource = {
    transaction: jest.fn(async (cb: (mm: typeof m) => Promise<unknown>) => cb(m)),
  };
  const outbox = { add: jest.fn().mockResolvedValue(undefined) };
  const scheduler = { addInterval: jest.fn(), deleteInterval: jest.fn(), doesExist: jest.fn() };
  const logger = { warn: jest.fn(), log: jest.fn() };
  const job = new DeadlineJob(
    deposits as never,
    dataSource as never,
    outbox as never,
    scheduler as never,
    { intervalMs: opts.intervalMs ?? 10000, reminderSeconds: REMINDER },
  );
  (job as unknown as { logger: typeof logger }).logger = logger;
  return { job, deposits, m, outbox, scheduler, logger };
}

beforeAll(() => jest.useFakeTimers({ now: NOW, doNotFake: ['nextTick', 'setImmediate'] }));
afterAll(() => jest.useRealTimers());

describe('DeadlineJob (BR-13: nhắc trước 24 giờ; chốt T3.5 B6)', () => {
  it('chọn PAID chưa nhắc, now < auto_release_at <= now + RELEASE_REMINDER_SECONDS, sớm nhất trước, tối đa 50', async () => {
    const { job, deposits } = setup({ due: [] });
    await job.runOnce();
    expect(deposits.find).toHaveBeenCalledWith({
      where: {
        status: 'PAID',
        releaseRemindedAt: IsNull(),
        autoReleaseAt: And(
          MoreThan(NOW),
          LessThanOrEqual(new Date(NOW.getTime() + REMINDER * 1000)),
        ),
      },
      order: { autoReleaseAt: 'ASC' },
      take: 50,
    });
  });

  it('test 15: một transaction đặt release_reminded_at (chỉ khi còn trống) + outbox rental.release-reminder kèm autoReleaseAt', async () => {
    const d = soon(1);
    const { job, m, outbox } = setup({ due: [d] });
    await expect(job.runOnce()).resolves.toMatchObject({ reminded: 1 });
    expect(m.update).toHaveBeenCalledWith(
      Deposit,
      { id: d.id, status: 'PAID', releaseRemindedAt: IsNull() },
      { releaseRemindedAt: NOW },
    );
    expect(outbox.add).toHaveBeenCalledWith(m, 'rental.release-reminder', {
      depositId: d.id,
      listingId: d.listingId,
      tenantId: d.tenantId,
      ownerId: d.ownerId,
      autoReleaseAt: d.autoReleaseAt.toISOString(),
    });
  });

  it('test 15: UPDATE 0 dòng (đã nhắc, hoặc đơn vừa đổi trạng thái) -> không phát lần hai', async () => {
    const { job, m, outbox } = setup();
    m.update.mockResolvedValueOnce({ affected: 0 });
    await expect(job.runOnce()).resolves.toMatchObject({ reminded: 0, skipped: 1 });
    expect(outbox.add).not.toHaveBeenCalled();
  });

  it('một đơn lỗi không chặn đơn khác', async () => {
    const { job, m, logger } = setup({ due: [soon(1), soon(2)] });
    m.update.mockRejectedValueOnce(new Error('db down'));
    await expect(job.runOnce()).resolves.toMatchObject({ reminded: 1, failed: 1 });
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining(soon(1).id));
  });

  it('đăng ký interval "deadline" theo DEADLINE_INTERVAL_MS; 0 -> tắt', () => {
    const on = setup({ intervalMs: 10000 });
    on.job.onApplicationBootstrap();
    expect(on.scheduler.addInterval).toHaveBeenCalledWith('deadline', expect.anything());
    clearInterval(on.scheduler.addInterval.mock.calls[0][1] as NodeJS.Timeout);
    const off = setup({ intervalMs: 0 });
    off.job.onApplicationBootstrap();
    expect(off.scheduler.addInterval).not.toHaveBeenCalled();
  });
});
