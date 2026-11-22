import { DeleteBucketCommand, GetObjectCommand, ListObjectsV2Command } from '@aws-sdk/client-s3';
import { randomUUID } from 'node:crypto';
import { StorageService } from '../src/storage/storage.service';
import type { TestApp } from './helpers/create-test-app';
import { readRootEnv } from './helpers/infra';

/**
 * StorageService với Silo (S3) THẬT (pnpm infra:up, rồi pnpm test:infra).
 * Bucket tạm `template-infra-test-<ngẫu nhiên>`, xóa ở cuối. Chỉ bật S3 (tắt DB/RabbitMQ).
 */
const bucket = `template-infra-test-${randomUUID().slice(0, 8)}`;

describe('StorageService với S3 thật', () => {
  let t: TestApp;
  let storage: StorageService;

  beforeAll(async () => {
    const root = readRootEnv();
    delete process.env.DATABASE_URL;
    delete process.env.RABBITMQ_URL;
    Object.assign(process.env, {
      S3_ENDPOINT: `http://localhost:${root.S3_API_PORT ?? '9000'}`,
      S3_ACCESS_KEY: root.S3_ACCESS_KEY,
      S3_SECRET_KEY: root.S3_SECRET_KEY,
      S3_BUCKETS: bucket,
    });
    const { createTestApp } = await import('./helpers/create-test-app');
    t = await createTestApp();
    storage = t.app.get(StorageService);
    await storage.bucketsReady;
  });

  afterAll(async () => {
    if (storage) {
      const list = await storage.client.send(new ListObjectsV2Command({ Bucket: bucket }));
      for (const o of list.Contents ?? []) await storage.deleteObject(bucket, o.Key as string);
      await storage.client.send(new DeleteBucketCommand({ Bucket: bucket })).catch(() => undefined);
    }
    await t?.app.close();
    for (const name of ['S3_ENDPOINT', 'S3_ACCESS_KEY', 'S3_SECRET_KEY', 'S3_BUCKETS']) {
      delete process.env[name];
    }
  });

  it('tự tạo bucket lúc khởi động; tạo lại lần nữa không lỗi', async () => {
    await expect(storage.ensureBucket(bucket)).resolves.toBeUndefined();
  });

  it('/health có checks.s3 = "up"', async () => {
    const res = await t.http().get('/health');
    expect(res.status).toBe(200);
    expect(res.body.checks).toEqual({ s3: 'up' });
  });

  it('putObject rồi đọc qua presigned GET URL', async () => {
    await storage.putObject(bucket, 'docs/a.txt', 'xin chào', 'text/plain; charset=utf-8');
    const url = await storage.presignGet(bucket, 'docs/a.txt', 60);
    expect(url).toContain('X-Amz-Signature=');
    const res = await fetch(url);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('xin chào');
  });

  it('client upload thẳng bằng presigned PUT URL', async () => {
    const url = await storage.presignPut(bucket, 'images/b.png', 'image/png', 60);
    const body = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
    const put = await fetch(url, { method: 'PUT', headers: { 'Content-Type': 'image/png' }, body });
    expect(put.status).toBe(200);
    const obj = await storage.client.send(
      new GetObjectCommand({ Bucket: bucket, Key: 'images/b.png' }),
    );
    expect(obj.ContentType).toBe('image/png');
    expect(Buffer.from(await obj.Body!.transformToByteArray())).toEqual(body);
  });

  it('presigned PUT sai Content-Type bị S3 từ chối (chữ ký không khớp)', async () => {
    const url = await storage.presignPut(bucket, 'images/c.png', 'image/png', 60);
    const put = await fetch(url, {
      method: 'PUT',
      headers: { 'Content-Type': 'text/html' },
      body: '<script>',
    });
    expect(put.status).toBe(403);
  });

  it('headObject: trả đúng kích thước và loại; không có object → null', async () => {
    const body = Buffer.alloc(1234, 1);
    await storage.putObject(bucket, 'images/d.png', body, 'image/png');
    await expect(storage.headObject(bucket, 'images/d.png')).resolves.toEqual({
      contentLength: 1234,
      contentType: 'image/png',
    });
    await expect(storage.headObject(bucket, 'images/khong-co.png')).resolves.toBeNull();
  });
});
