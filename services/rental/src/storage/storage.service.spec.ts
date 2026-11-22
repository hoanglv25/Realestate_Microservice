import { S3ServiceException } from '@aws-sdk/client-s3';
import { ConfigService } from '@nestjs/config';
import { PinoLogger } from 'nestjs-pino';
import { EnvVars } from '../config/env.validation';
import { HealthRegistry } from '../health/health.registry';
import { StorageService } from './storage.service';

/** Dựng StorageService với S3 giả (không gọi mạng): thay `client.send` bằng hàm của test. */
function makeService(send: jest.Mock): StorageService {
  const values: Partial<EnvVars> = {
    S3_ENDPOINT: 'http://localhost:9000',
    S3_ACCESS_KEY: 'k',
    S3_SECRET_KEY: 's',
    S3_REGION: 'us-east-1',
    S3_FORCE_PATH_STYLE: true,
    S3_BUCKETS: [],
    S3_PRESIGN_TTL_SECONDS: 900,
  };
  const config = { get: (name: keyof EnvVars) => values[name] } as ConfigService<EnvVars, true>;
  const logger = { setContext: jest.fn() } as unknown as PinoLogger;
  const service = new StorageService(config, new HealthRegistry(), logger);
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
