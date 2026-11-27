import { ListObjectsV2Command, GetObjectCommand } from '@aws-sdk/client-s3';
import { randomUUID } from 'node:crypto';
import { StorageService } from '../src/storage/storage.service';
import type { TestApp } from './helpers/create-test-app';
import { readRootEnv, s3TestEnv } from './helpers/infra';

/**
 * StorageService với S3 THẬT (Cloudflare R2, ADR-0016), cấu hình lấy từ .env gốc:
 * `S3_ENDPOINT`, `S3_REGION`, `S3_ACCESS_KEY`, `S3_SECRET_KEY`, `S3_TEST_BUCKET` (bucket có sẵn,
 * R2: `infra-test`). Thiếu biến → bỏ qua cả file. Không tạo hay xóa bucket: chỉ ghi dưới tiền tố
 * riêng của lượt chạy và xóa đúng các key đó. Chỉ bật S3 (tắt DB/RabbitMQ).
 */
const s3 = s3TestEnv(readRootEnv());
const prefix = `infra-test/${randomUUID()}/`;
const describeS3 = s3 ? describe : describe.skip;

describeS3('StorageService với S3 thật', () => {
  const bucket = s3?.bucket as string;
  let t: TestApp;
  let storage: StorageService;

  beforeAll(async () => {
    if (!s3) return;
    delete process.env.DATABASE_URL;
    delete process.env.RABBITMQ_URL;
    Object.assign(process.env, {
      S3_ENDPOINT: s3.endpoint,
      S3_REGION: s3.region,
      S3_ACCESS_KEY: s3.accessKey,
      S3_SECRET_KEY: s3.secretKey,
      S3_BUCKETS: bucket,
    });
    const { createTestApp } = await import('./helpers/create-test-app');
    t = await createTestApp();
    storage = t.app.get(StorageService);
  });

  afterAll(async () => {
    if (storage) {
      const list = await storage.client.send(
        new ListObjectsV2Command({ Bucket: bucket, Prefix: prefix }),
      );
      for (const o of list.Contents ?? []) await storage.deleteObject(bucket, o.Key as string);
    }
    await t?.app.close();
    for (const name of [
      'S3_ENDPOINT',
      'S3_REGION',
      'S3_ACCESS_KEY',
      'S3_SECRET_KEY',
      'S3_BUCKETS',
    ]) {
      delete process.env[name];
    }
  });

  it('/health có checks.s3 = "up" với bucket có sẵn (không tạo bucket)', async () => {
    const res = await t.http().get('/health');
    expect(res.status).toBe(200);
    expect(res.body.checks).toEqual({ s3: 'up' });
  });

  it('putObject rồi đọc qua presigned GET URL', async () => {
    const key = `${prefix}docs/a.txt`;
    await storage.putObject(bucket, key, 'xin chào', 'text/plain; charset=utf-8');
    const url = await storage.presignGet(bucket, key, 60);
    expect(url).toContain('X-Amz-Signature=');
    const res = await fetch(url);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('xin chào');
  });

  it('client upload thẳng bằng presigned PUT URL', async () => {
    const key = `${prefix}images/b.png`;
    const url = await storage.presignPut(bucket, key, 'image/png', 60);
    const body = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
    const put = await fetch(url, { method: 'PUT', headers: { 'Content-Type': 'image/png' }, body });
    expect(put.status).toBe(200);
    const obj = await storage.client.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
    expect(obj.ContentType).toBe('image/png');
    expect(Buffer.from(await obj.Body!.transformToByteArray())).toEqual(body);
  });

  it('presigned PUT sai Content-Type bị S3 từ chối (chữ ký không khớp)', async () => {
    const url = await storage.presignPut(bucket, `${prefix}images/c.png`, 'image/png', 60);
    const put = await fetch(url, {
      method: 'PUT',
      headers: { 'Content-Type': 'text/html' },
      body: '<script>',
    });
    expect(put.status).toBe(403);
  });

  it('headObject: trả đúng kích thước và loại; không có object → null', async () => {
    const key = `${prefix}images/d.png`;
    await storage.putObject(bucket, key, Buffer.alloc(1234, 1), 'image/png');
    await expect(storage.headObject(bucket, key)).resolves.toEqual({
      contentLength: 1234,
      contentType: 'image/png',
    });
    await expect(storage.headObject(bucket, `${prefix}images/khong-co.png`)).resolves.toBeNull();
  });
});
