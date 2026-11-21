import { Controller, Get, HttpCode, Post, StreamableFile } from '@nestjs/common';
import { ApiConflictResponse, ApiProperty } from '@nestjs/swagger';
import { Public } from '../src/common/auth/public.decorator';
import { ErrorResponseDto } from '../src/common/errors/error-response.dto';
import { ApiEnvelope } from '../src/common/response/api-envelope.decorator';
import { RawResponse } from '../src/common/response/raw-response.decorator';
import { Paginated } from '../src/common/response/response-meta';
import { createTestApp, TestApp, UUID_V4 } from './helpers/create-test-app';

class ItemDto {
  @ApiProperty()
  id!: number;
}

/** Controller chỉ dùng trong test: mỗi route minh họa một trường hợp của khung { data, meta }. */
@Public()
@Controller('test-envelope')
class EnvelopeTestController {
  @Get('object')
  @ApiEnvelope(ItemDto)
  @ApiConflictResponse({ type: ErrorResponseDto })
  object(): ItemDto {
    return { id: 1 };
  }

  @Get('list')
  @ApiEnvelope(ItemDto, { isArray: true })
  list(): Paginated<ItemDto> {
    return new Paginated([{ id: 1 }, { id: 2 }], 2, 2, 5);
  }

  @Get('array')
  array(): number[] {
    return [1, 2, 3];
  }

  @Get('string')
  string(): string {
    return 'xin chào';
  }

  @Get('null')
  nothing(): null {
    return null;
  }

  @Post('void')
  @HttpCode(200)
  noResult(): void {
    // không trả gì
  }

  @Post('no-content')
  @HttpCode(204)
  noContent(): void {
    // 204: không có body
  }

  @Get('raw')
  @RawResponse()
  raw(): { plain: true } {
    return { plain: true };
  }

  @Get('file')
  file(): StreamableFile {
    return new StreamableFile(Buffer.from('nội dung file'));
  }
}

describe('Khung response { data, meta } và { error, meta }', () => {
  let t: TestApp;

  beforeAll(async () => {
    t = await createTestApp([EnvelopeTestController], [], { swagger: true });
  });

  afterAll(async () => {
    await t.app.close();
  });

  it('đối tượng -> { data, meta } với correlationId khớp header và timestamp ISO', async () => {
    const res = await t.http().get('/api/v1/test-envelope/object').set('X-Request-ID', 'env-1');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      data: { id: 1 },
      meta: { correlationId: 'env-1', timestamp: expect.any(String) },
    });
    expect(res.headers['x-request-id']).toBe('env-1');
    expect(new Date(res.body.meta.timestamp).toISOString()).toBe(res.body.meta.timestamp);
  });

  it('không gửi X-Request-ID -> meta.correlationId là UUID tự sinh, trùng header', async () => {
    const res = await t.http().get('/api/v1/test-envelope/object');
    expect(res.body.meta.correlationId).toMatch(UUID_V4);
    expect(res.headers['x-request-id']).toBe(res.body.meta.correlationId);
  });

  it('Paginated -> data là mảng, meta thêm page/pageSize/total/totalPages', async () => {
    const res = await t.http().get('/api/v1/test-envelope/list');
    expect(res.body.data).toEqual([{ id: 1 }, { id: 2 }]);
    expect(res.body.meta).toMatchObject({ page: 2, pageSize: 2, total: 5, totalPages: 3 });
  });

  it('mảng thường, chuỗi và null đều nằm trong data', async () => {
    expect((await t.http().get('/api/v1/test-envelope/array')).body.data).toEqual([1, 2, 3]);
    expect((await t.http().get('/api/v1/test-envelope/string')).body.data).toBe('xin chào');
    expect((await t.http().get('/api/v1/test-envelope/null')).body.data).toBeNull();
  });

  it('handler không trả gì (200) -> data: null để luôn có khóa data', async () => {
    const res = await t.http().post('/api/v1/test-envelope/void');
    expect(res.status).toBe(200);
    expect(res.body.data).toBeNull();
    expect(res.body.meta.correlationId).toBeDefined();
  });

  it('@HttpCode(204) -> không có body', async () => {
    const res = await t.http().post('/api/v1/test-envelope/no-content');
    expect(res.status).toBe(204);
    expect(res.text).toBe('');
  });

  it('@RawResponse() và /health giữ body phẳng, không bọc', async () => {
    const raw = await t.http().get('/api/v1/test-envelope/raw');
    expect(raw.body).toEqual({ plain: true });

    const health = await t.http().get('/health');
    expect(health.body.status).toBe('ok');
    expect(health.body).not.toHaveProperty('data');
    expect(health.body).not.toHaveProperty('meta');
  });

  it('file/stream không bị bọc', async () => {
    const res = await t.http().get('/api/v1/test-envelope/file').buffer(true);
    expect(res.status).toBe(200);
    expect(res.body.toString()).toBe('nội dung file');
  });

  it('lỗi -> { error, meta } và KHÔNG có data', async () => {
    const res = await t.http().get('/api/v1/test-envelope/khong-co').set('X-Request-ID', 'env-404');
    expect(res.status).toBe(404);
    expect(res.body).toEqual({
      error: { code: 'NOT_FOUND', message: expect.any(String) },
      meta: { correlationId: 'env-404', timestamp: expect.any(String) },
    });
    expect(res.body).not.toHaveProperty('data');
  });

  it('Swagger: @ApiEnvelope mô tả { data, meta }, danh sách thì data là mảng', async () => {
    const doc = (await t.http().get('/api/docs-json')).body;
    const schemas = doc.components.schemas;
    expect(schemas.ResponseMetaDto.required).toEqual(['correlationId', 'timestamp']);

    const single =
      doc.paths['/api/v1/test-envelope/object'].get.responses['200'].content['application/json']
        .schema;
    expect(single.required).toEqual(['data', 'meta']);
    expect(single.properties.data).toEqual({ $ref: '#/components/schemas/ItemDto' });
    expect(single.properties.meta).toEqual({ $ref: '#/components/schemas/ResponseMetaDto' });

    const list =
      doc.paths['/api/v1/test-envelope/list'].get.responses['200'].content['application/json']
        .schema;
    expect(list.properties.data).toEqual({
      type: 'array',
      items: { $ref: '#/components/schemas/ItemDto' },
    });
  });

  it('Swagger: ErrorResponseDto mô tả { error: {code,message,details}, meta }', async () => {
    const doc = (await t.http().get('/api/docs-json')).body;
    const err = doc.components.schemas.ErrorResponseDto;
    expect(err).toBeDefined();
    expect(Object.keys(err.properties).sort()).toEqual(['error', 'meta']);
    expect(Object.keys(doc.components.schemas.ErrorBodyDto.properties).sort()).toEqual([
      'code',
      'details',
      'message',
    ]);
  });
});
