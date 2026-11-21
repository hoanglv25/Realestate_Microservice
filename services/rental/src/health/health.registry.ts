import { Injectable } from '@nestjs/common';

/** Hàm kiểm tra một phụ thuộc: trả true nếu còn sống, false (hoặc ném lỗi) nếu chết. */
export type HealthProbe = () => Promise<boolean>;

/**
 * Nơi các module tùy chọn (Database, Redis, sau này RabbitMQ) tự đăng ký health check của mình.
 * Nhờ vậy `checks` trong /health chỉ có các phụ thuộc ĐANG ĐƯỢC BẬT, và thêm phụ thuộc mới
 * không cần sửa HealthController:
 *
 *   constructor(private readonly registry: HealthRegistry) {}
 *   onModuleInit() { this.registry.register('rabbitmq', async () => this.channel.isOpen()); }
 */
@Injectable()
export class HealthRegistry {
  private readonly probes = new Map<string, HealthProbe>();

  register(name: string, probe: HealthProbe): void {
    this.probes.set(name, probe);
  }

  entries(): Array<[string, HealthProbe]> {
    return [...this.probes.entries()];
  }
}
