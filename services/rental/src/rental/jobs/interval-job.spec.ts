import { IntervalJob } from './interval-job';

/** Job thử: `runOnce` do test điều khiển. */
class TestJob extends IntervalJob {
  readonly runOnce = jest.fn<Promise<unknown>, []>().mockResolvedValue(undefined);

  constructor(scheduler: never, intervalMs: number) {
    super(scheduler, 'test-job', intervalMs);
  }
}

function setup(intervalMs = 5000) {
  const scheduler = {
    addInterval: jest.fn(),
    deleteInterval: jest.fn(),
    doesExist: jest.fn().mockReturnValue(true),
  };
  const logger = { warn: jest.fn(), log: jest.fn() };
  const job = new TestJob(scheduler as never, intervalMs);
  (job as unknown as { logger: typeof logger }).logger = logger;
  return { job, scheduler, logger };
}

describe('IntervalJob (RE.DEPOSIT_SAGA/Component_Class_Design.md §7, T3.4b B5)', () => {
  beforeEach(() => jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate'] }));
  afterEach(() => {
    jest.clearAllTimers();
    jest.useRealTimers();
  });

  it('intervalMs > 0: đăng ký interval đúng tên lúc khởi động; mỗi chu kỳ chạy một lượt', async () => {
    const { job, scheduler } = setup(5000);
    job.onApplicationBootstrap();
    expect(scheduler.addInterval).toHaveBeenCalledTimes(1);
    expect(scheduler.addInterval).toHaveBeenCalledWith('test-job', expect.anything());

    jest.advanceTimersByTime(5000);
    await Promise.resolve();
    expect(job.runOnce).toHaveBeenCalledTimes(1);
    jest.advanceTimersByTime(5000);
    await Promise.resolve();
    expect(job.runOnce).toHaveBeenCalledTimes(2);
  });

  it('intervalMs = 0: không đăng ký (tắt lịch, test gọi runOnce trực tiếp)', () => {
    const { job, scheduler } = setup(0);
    job.onApplicationBootstrap();
    expect(scheduler.addInterval).not.toHaveBeenCalled();
  });

  it('lượt trước chưa xong thì bỏ lượt mới (không chạy chồng); xong rồi thì lượt sau chạy lại', async () => {
    const { job } = setup();
    let release!: () => void;
    job.runOnce.mockImplementationOnce(() => new Promise((r) => (release = () => r(undefined))));
    const first = job.tick();
    await job.tick(); // bỏ qua
    expect(job.runOnce).toHaveBeenCalledTimes(1);
    release();
    await first;
    await job.tick();
    expect(job.runOnce).toHaveBeenCalledTimes(2);
  });

  it('lượt lỗi (ví dụ DB) -> chỉ log warn, không ném ra; lượt sau vẫn chạy', async () => {
    const { job, logger } = setup();
    job.runOnce.mockRejectedValueOnce(new Error('db down'));
    await expect(job.tick()).resolves.toBeUndefined();
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('db down'));
    await job.tick();
    expect(job.runOnce).toHaveBeenCalledTimes(2);
  });

  it('tắt app: xóa interval nếu còn; ScheduleModule đã dọn trước thì không xóa lại', () => {
    const { job, scheduler } = setup();
    job.onApplicationShutdown();
    expect(scheduler.deleteInterval).toHaveBeenCalledWith('test-job');
    scheduler.doesExist.mockReturnValue(false);
    scheduler.deleteInterval.mockClear();
    job.onApplicationShutdown();
    expect(scheduler.deleteInterval).not.toHaveBeenCalled();
  });
});
