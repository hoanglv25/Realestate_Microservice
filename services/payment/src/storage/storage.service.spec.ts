import { S3ServiceException } from '@aws-sdk/client-s3';
import { ConfigService } from '@nestjs/config';
import { PinoLogger } from 'nestjs-pino';
import { EnvVars } from '../config/env.validation';
import { HealthRegistry } from '../health/health.registry';
import { StorageService } from './storage.service';

/** Dựng StorageService với S3 giả (không gọi mạng): thay `client.send` bằng hàm của test. */
function makeService(
  send: jest.Mock,
  buckets: string[] = [],
  registry = new HealthRegistry(),
): StorageService {
  const values: Partial<EnvVars> = {
    S3_ENDPOINT: 'http://localhost:9000',
    S3_ACCESS_KEY: 'k',
    S3_SECRET_KEY: 's',
    S3_REGION: 'us-east-1',
    S3_FORCE_PATH_STYLE: true,
    S3_BUCKETS: buckets,
    S3_PRESIGN_TTL_SECONDS: 900,
  };
  const config = { get: (name: keyof EnvVars) => values[name] } as ConfigService<EnvVars, true>;
  const logger = { setContext: jest.fn() } as unknown as PinoLogger;
  const service = new StorageService(config, registry, logger);
  (service.client as unknown as { send: jest.Mock }).send = send;
  return service;
}

const s3Error = (name: string, status: number): S3ServiceException =>
  new S3ServiceException({
    name,
    $fault: 'client',
    $metadata: { httpStatusCode: status },
    message: name,
  });

describe('StorageService.headObject', () => {
  it('có object: trả contentLength và contentType', async () => {
    const send = jest.fn().mockResolvedValue({ ContentLength: 1234, ContentType: 'image/png' });
    const service = makeService(send);

    await expect(service.headObject('listing-images', 'listings/x/a.png')).resolves.toEqual({
      contentLength: 1234,
      contentType: 'image/png',
    });
    expect(send.mock.calls[0][0].input).toEqual({
      Bucket: 'listing-images',
      Key: 'listings/x/a.png',
    });
  });

  it.each([
    ['NotFound', 404],
    ['NoSuchKey', 404],
  ])('%s (HTTP %i): không có object → null', async (name, status) => {
    const service = makeService(jest.fn().mockRejectedValue(s3Error(name, status)));
    await expect(service.headObject('b', 'k')).resolves.toBeNull();
  });

  it('thiếu ContentLength thì coi là 0, thiếu ContentType thì undefined', async () => {
    const service = makeService(jest.fn().mockResolvedValue({}));
    await expect(service.headObject('b', 'k')).resolves.toEqual({
      contentLength: 0,
      contentType: undefined,
    });
  });

  it('lỗi khác (403, mất kết nối) ném lại, không nuốt thành null', async () => {
    const forbidden = s3Error('Forbidden', 403);
    await expect(
      makeService(jest.fn().mockRejectedValue(forbidden)).headObject('b', 'k'),
    ).rejects.toBe(forbidden);

    const down = new Error('ECONNREFUSED');
    await expect(makeService(jest.fn().mockRejectedValue(down)).headObject('b', 'k')).rejects.toBe(
      down,
    );
  });
});

describe('StorageService khi khởi động (v2.2, ADR-0016: bucket tạo sẵn)', () => {
  /** Chạy các hook vòng đời mà Nest sẽ gọi lúc khởi động, nếu service có. */
  async function boot(service: StorageService): Promise<void> {
    const hooks = service as unknown as {
      onModuleInit?: () => unknown;
      onApplicationBootstrap?: () => unknown;
    };
    await hooks.onModuleInit?.();
    await hooks.onApplicationBootstrap?.();
    await new Promise((resolve) => setImmediate(resolve));
  }

  it('có S3_BUCKETS: không gửi lệnh S3 nào (không CreateBucket)', async () => {
    const send = jest.fn().mockResolvedValue({});
    await boot(makeService(send, ['listing-images', 'payment-proofs']));
    expect(send).not.toHaveBeenCalled();
  });

  it('không còn API tạo bucket', () => {
    const service = makeService(jest.fn()) as unknown as Record<string, unknown>;
    expect(service.ensureBucket).toBeUndefined();
    expect(service.bucketsReady).toBeUndefined();
  });

  it('health s3: HeadBucket bucket đầu tiên; S3_BUCKETS rỗng thì ListBuckets', async () => {
    const send = jest.fn().mockResolvedValue({});
    const registry = new HealthRegistry();
    await boot(makeService(send, ['listing-images', 'payment-proofs'], registry));
    const probe = new Map(registry.entries()).get('s3');
    await expect(probe?.()).resolves.toBe(true);
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0][0].constructor.name).toBe('HeadBucketCommand');
    expect(send.mock.calls[0][0].input).toEqual({ Bucket: 'listing-images' });

    const send2 = jest.fn().mockResolvedValue({ Buckets: [] });
    const registry2 = new HealthRegistry();
    await boot(makeService(send2, [], registry2));
    await expect(new Map(registry2.entries()).get('s3')?.()).resolves.toBe(true);
    expect(send2.mock.calls[0][0].constructor.name).toBe('ListBucketsCommand');
  });

  it('health s3: lỗi S3 (sai khóa, bucket không có) ném lại để /health báo down', async () => {
    const denied = s3Error('Forbidden', 403);
    const registry = new HealthRegistry();
    await boot(makeService(jest.fn().mockRejectedValue(denied), ['listing-images'], registry));
    await expect(new Map(registry.entries()).get('s3')?.()).rejects.toBe(denied);
  });
});
