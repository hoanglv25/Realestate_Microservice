import { Injectable, OnApplicationShutdown, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadBucketCommand,
  HeadObjectCommand,
  ListBucketsCommand,
  PutObjectCommand,
  S3Client,
  S3ServiceException,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { PinoLogger } from 'nestjs-pino';
import { EnvVars } from '../config/env.validation';
import { HealthRegistry } from '../health/health.registry';

/** Mã lỗi S3 khi object không tồn tại (HeadObject không có body nên thường chỉ có HTTP 404). */
const NOT_FOUND = new Set(['NotFound', 'NoSuchKey']);

/** Kích thước và loại của một object trên S3 (kết quả HeadObject). */
export interface ObjectHead {
  contentLength: number;
  contentType?: string;
}

/**
 * Object storage qua API S3 (Cloudflare R2, xem decisions/0016). Không phụ thuộc gì riêng của
 * nhà cung cấp: đổi sang dịch vụ S3 khác chỉ cần đổi biến S3_*.
 *
 * - KHÔNG tạo bucket: bucket trong S3_BUCKETS phải có sẵn (tạo tay trên dashboard). Khởi động
 *   không gửi lệnh S3 nào; token chỉ cần quyền đọc/ghi object.
 * - Health check 's3': HeadBucket bucket đầu tiên của S3_BUCKETS (rỗng thì ListBuckets).
 * - Upload từ trình duyệt: cấp presigned PUT URL cho client đẩy file thẳng lên S3, service chỉ lưu key.
 */
@Injectable()
export class StorageService implements OnModuleInit, OnApplicationShutdown {
  readonly client: S3Client;
  /** Chỉ dùng để KÝ URL (không gọi mạng): host là S3_PUBLIC_ENDPOINT nếu có. */
  private readonly presigner: S3Client;
  private readonly buckets: string[];
  private readonly presignTtl: number;

  constructor(
    config: ConfigService<EnvVars, true>,
    private readonly registry: HealthRegistry,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(StorageService.name);
    const endpoint = config.get('S3_ENDPOINT', { infer: true }) as string;
    const common = {
      region: config.get('S3_REGION', { infer: true }),
      forcePathStyle: config.get('S3_FORCE_PATH_STYLE', { infer: true }),
      credentials: {
        accessKeyId: config.get('S3_ACCESS_KEY', { infer: true }) as string,
        secretAccessKey: config.get('S3_SECRET_KEY', { infer: true }) as string,
      },
    };
    this.client = new S3Client({ ...common, endpoint, maxAttempts: 2 });
    this.presigner = new S3Client({
      ...common,
      endpoint: config.get('S3_PUBLIC_ENDPOINT', { infer: true }) ?? endpoint,
    });
    this.buckets = config.get('S3_BUCKETS', { infer: true });
    this.presignTtl = config.get('S3_PRESIGN_TTL_SECONDS', { infer: true });
  }

  onModuleInit(): void {
    this.registry.register('s3', async () => {
      if (this.buckets.length > 0) {
        await this.client.send(new HeadBucketCommand({ Bucket: this.buckets[0] }));
      } else {
        await this.client.send(new ListBucketsCommand({}));
      }
      return true;
    });
  }

  onApplicationShutdown(): void {
    this.client.destroy();
    this.presigner.destroy();
  }

  async putObject(
    bucket: string,
    key: string,
    body: Buffer | string,
    contentType = 'application/octet-stream',
  ): Promise<void> {
    await this.client.send(
      new PutObjectCommand({ Bucket: bucket, Key: key, Body: body, ContentType: contentType }),
    );
  }

  async deleteObject(bucket: string, key: string): Promise<void> {
    await this.client.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
  }

  /**
   * HeadObject: kích thước và loại của object. Trả `null` khi không có object (NotFound/NoSuchKey,
   * HTTP 404); lỗi khác (403, mất kết nối...) ném lại. Dùng sau khi client tải lên bằng presigned PUT
   * để kiểm kích thước, vì presigned PUT không giới hạn được (gotchas.md).
   */
  async headObject(bucket: string, key: string): Promise<ObjectHead | null> {
    try {
      const out = await this.client.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
      return { contentLength: out.ContentLength ?? 0, contentType: out.ContentType };
    } catch (err) {
      if (
        err instanceof S3ServiceException &&
        (err.$metadata?.httpStatusCode === 404 || NOT_FOUND.has(err.name))
      ) {
        return null;
      }
      throw err;
    }
  }

  /** URL tạm để trình duyệt xem/tải file (mặc định S3_PRESIGN_TTL_SECONDS). */
  presignGet(bucket: string, key: string, expiresInSeconds = this.presignTtl): Promise<string> {
    return getSignedUrl(this.presigner, new GetObjectCommand({ Bucket: bucket, Key: key }), {
      expiresIn: expiresInSeconds,
    });
  }

  /**
   * URL tạm để client upload thẳng (HTTP PUT, header Content-Type phải đúng `contentType`).
   * Content-Type được KÝ vào URL (mặc định SDK không ký), nên client không đổi được loại file,
   * ví dụ không thể đẩy HTML vào chỗ dành cho ảnh.
   * Presigned PUT KHÔNG giới hạn được kích thước file: kiểm tra lại (HeadObject) trước khi dùng key.
   */
  presignPut(
    bucket: string,
    key: string,
    contentType: string,
    expiresInSeconds = this.presignTtl,
  ): Promise<string> {
    return getSignedUrl(
      this.presigner,
      new PutObjectCommand({ Bucket: bucket, Key: key, ContentType: contentType }),
      { expiresIn: expiresInSeconds, signableHeaders: new Set(['content-type']) },
    );
  }
}
