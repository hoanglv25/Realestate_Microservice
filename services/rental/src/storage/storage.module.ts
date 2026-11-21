import { Global, Module } from '@nestjs/common';
import { StorageService } from './storage.service';

/**
 * TÙY CHỌN: chỉ được nạp khi có S3_ENDPOINT (bắt buộc kèm S3_ACCESS_KEY, S3_SECRET_KEY),
 * xem app.module.ts. Bucket cần tạo khai báo ở S3_BUCKETS.
 */
@Global()
@Module({
  providers: [StorageService],
  exports: [StorageService],
})
export class StorageModule {}
