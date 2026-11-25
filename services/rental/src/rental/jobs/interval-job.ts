import { Logger, OnApplicationBootstrap, OnApplicationShutdown } from '@nestjs/common';
import type { SchedulerRegistry } from '@nestjs/schedule';

/**
 * Khung chạy định kỳ dùng chung cho các job của rental (`RE.DEPOSIT_SAGA/Component_Class_Design.md §7`, chốt
 * T3.4b B5): `SagaReconcileJob`, `HoldExpiryJob`, sau này job của `RE.DEPOSIT_LIFECYCLE`.
 *
 * - Lúc khởi động đăng ký `setInterval` vào `SchedulerRegistry` (`@nestjs/schedule` 6.1.3) theo biến `*_INTERVAL_MS`;
 *   `0` = tắt lịch (test gọi `runOnce()` trực tiếp).
 * - Lượt trước chưa xong thì bỏ lượt mới (không chạy chồng).
 * - Lượt lỗi (DB...) chỉ log `warn`, không làm dừng lịch; lượt sau chạy lại.
 * - Tắt app: xóa interval nếu `ScheduleModule` chưa tự dọn.
 *
 * Lớp con chỉ viết `runOnce()`: một lượt xử lý, chạy lại an toàn (mọi thay đổi là `UPDATE ... WHERE` theo trạng thái).
 * Một bản sao rental (§7 chốt 2026-11-16: không `FOR UPDATE SKIP LOCKED`).
 */
export abstract class IntervalJob implements OnApplicationBootstrap, OnApplicationShutdown {
  protected readonly logger = new Logger(this.constructor.name);
  private running = false;

  protected constructor(
    private readonly schedulerRegistry: SchedulerRegistry,
    private readonly jobName: string,
    private readonly intervalMs: number,
  ) {}

  /** Một lượt xử lý. */
  abstract runOnce(): Promise<unknown>;

  onApplicationBootstrap(): void {
    if (this.intervalMs <= 0) return;
    this.schedulerRegistry.addInterval(
      this.jobName,
      setInterval(() => void this.tick(), this.intervalMs),
    );
  }

  onApplicationShutdown(): void {
    // ScheduleModule cũng tự dọn interval khi tắt: chỉ xóa nếu còn
    if (this.schedulerRegistry.doesExist('interval', this.jobName)) {
      this.schedulerRegistry.deleteInterval(this.jobName);
    }
  }

  /** Một lượt theo lịch; bỏ qua nếu lượt trước chưa xong; lỗi không làm dừng lịch. */
  async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      await this.runOnce();
    } catch (err) {
      this.logger.warn(`${this.jobName} lỗi (DB?), lượt sau chạy lại: ${(err as Error).message}`);
    } finally {
      this.running = false;
    }
  }
}
