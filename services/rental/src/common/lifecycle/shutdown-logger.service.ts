import { BeforeApplicationShutdown, Injectable, OnApplicationShutdown } from '@nestjs/common';
import { PinoLogger } from 'nestjs-pino';

/**
 * Ghi log khi service tắt để thấy rõ trình tự graceful shutdown (SIGTERM từ `docker stop`):
 *   nhận tín hiệu -> (module đóng Redis/DB) -> đã dừng.
 * Cần `app.enableShutdownHooks()` trong main.ts.
 */
@Injectable()
export class ShutdownLoggerService implements BeforeApplicationShutdown, OnApplicationShutdown {
  constructor(private readonly logger: PinoLogger) {
    this.logger.setContext(ShutdownLoggerService.name);
  }

  beforeApplicationShutdown(signal?: string): void {
    this.logger.info({ signal }, 'Nhận tín hiệu tắt, đang đóng các kết nối');
  }

  onApplicationShutdown(signal?: string): void {
    this.logger.info({ signal }, 'Service đã dừng gọn');
  }
}
