import { Body, Controller, ForbiddenException, Get, Post } from '@nestjs/common';
import { IsInt, IsString, Min, MinLength } from 'class-validator';
import { Public } from '../src/common/auth/public.decorator';
import { AppException } from '../src/common/errors/app.exception';
import { createTestApp, TestApp, UUID_V4 } from './helpers/create-test-app';

class DemoDto {
  @IsString()
  @MinLength(3)
  name!: string;

  @IsInt()
  @Min(0)
  priceVnd!: number;
}

// Controller chỉ dùng trong test để ép từng loại lỗi xảy ra
@Public()
@Controller('test-errors')
class TestErrorsController {
  @Get('app-409')
  app409(): never {
    throw new AppException('DEMO_CONFLICT', 'Tên đã tồn tại', 409, { field: 'name' });
  }

  @Get('forbidden')
  forbidden(): never {
    throw new ForbiddenException('Bạn không có quyền');
  }

  @Get('boom')
  boom(): never {
    throw new Error('mat khau DB la hunter2 tai /srv/app/secret.service.ts:42');
  }

  @Get('conn')
  conn(): never {
    throw Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:5432'), { code: 'ECONNREFUSED' });
  }

  @Get('timeout')
  timeout(): never {
    throw Object.assign(new Error('timed out'), { code: 'ETIMEDOUT' });
  }

  @Post('validate')
  validate(@Body() dto: DemoDto): DemoDto {
    return dto;
  }
}

describe('Định dạng lỗi thống nhất', () => {
  let t: TestApp;

  beforeAll(async () => {
    t = await createTestApp([TestErrorsController]);
  });
  afterAll(async () => {
    await t.app.close();
  });

  it('AppException -> đúng status, code, message, details, correlationId', async () => {
    const res = await t.http().get('/api/v1/test-errors/app-409').set('X-Request-ID', 'abc-123');
    expect(res.status).toBe(409);
    expect(res.body).toEqual({
      error: {
        code: 'DEMO_CONFLICT',
        message: 'Tên đã tồn tại',
        details: { field: 'name' },
      },
      meta: { correlationId: 'abc-123', timestamp: expect.any(String) },
    });
    expect(res.headers['x-request-id']).toBe('abc-123');
  });

  it('HttpException có sẵn của Nest -> map code theo status', async () => {
    const res = await t.http().get('/api/v1/test-errors/forbidden');
    expect(res.status).toBe(403);
    expect(res.body.error).toMatchObject({ code: 'FORBIDDEN', message: 'Bạn không có quyền' });
    expect(res.body.error.details).toBeUndefined();
  });

  it('Route không tồn tại -> 404 NOT_FOUND và vẫn có correlationId', async () => {
    const res = await t.http().get('/khong-co-route').set('X-Request-ID', 'nf-1');
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('NOT_FOUND');
    expect(res.body.meta.correlationId).toBe('nf-1');
    expect(res.headers['x-request-id']).toBe('nf-1');
  });

  it('ValidationPipe -> 400 VALIDATION_FAILED, details theo từng trường, chặn trường thừa', async () => {
    const res = await t
      .http()
      .post('/api/v1/test-errors/validate')
      .send({ name: 'ab', priceVnd: -1, extra: 1 });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_FAILED');
    expect(typeof res.body.meta.correlationId).toBe('string');
    const fields = (res.body.error.details as Array<{ field: string }>).map((d) => d.field).sort();
    expect(fields).toEqual(['extra', 'name', 'priceVnd']);
  });

  it('DTO hợp lệ đi qua bình thường', async () => {
    const res = await t
      .http()
      .post('/api/v1/test-errors/validate')
      .send({ name: 'abc', priceVnd: 1500000 });
    expect(res.status).toBe(201);
    expect(res.body.data).toEqual({ name: 'abc', priceVnd: 1500000 });
  });

  it('JSON sai cú pháp -> 400 BAD_REQUEST đúng format', async () => {
    const res = await t
      .http()
      .post('/api/v1/test-errors/validate')
      .set('Content-Type', 'application/json')
      .send('{bad json');
    expect(res.status).toBe(400);
    expect(res.body.error).toMatchObject({ code: 'BAD_REQUEST' });
    expect(res.body.meta.correlationId).toBeDefined();
  });

  it('Body quá lớn -> 413 PAYLOAD_TOO_LARGE đúng format', async () => {
    const res = await t
      .http()
      .post('/api/v1/test-errors/validate')
      .send({ name: 'x'.repeat(200_000), priceVnd: 1 });
    expect(res.status).toBe(413);
    expect(res.body).toEqual({
      error: { code: 'PAYLOAD_TOO_LARGE', message: expect.any(String) },
      meta: { correlationId: expect.any(String), timestamp: expect.any(String) },
    });
  });

  it('Lỗi không lường trước -> 500, KHÔNG lộ message/stack, nhưng có log phía server', async () => {
    const res = await t.http().get('/api/v1/test-errors/boom').set('X-Request-ID', 'boom-1');
    expect(res.status).toBe(500);
    expect(res.body).toEqual({
      error: { code: 'INTERNAL_ERROR', message: 'Lỗi hệ thống, vui lòng thử lại sau' },
      meta: { correlationId: 'boom-1', timestamp: expect.any(String) },
    });
    const raw = JSON.stringify(res.body);
    expect(raw).not.toContain('hunter2');
    expect(raw).not.toContain('secret.service.ts');
    expect(raw).not.toMatch(/stack|\bat \w/);

    const serverLog = t
      .logRecords()
      .find((r) => r.level === 'error' && r.correlationId === 'boom-1' && r.err);
    expect(serverLog).toBeDefined();
    expect(JSON.stringify(serverLog)).toContain('hunter2'); // chi tiết CHỈ nằm trong log nội bộ
  });

  it('Lỗi kết nối hạ tầng -> 503 DEPENDENCY_UNAVAILABLE', async () => {
    const res = await t.http().get('/api/v1/test-errors/conn');
    expect(res.status).toBe(503);
    expect(res.body.error.code).toBe('DEPENDENCY_UNAVAILABLE');
    expect(JSON.stringify(res.body)).not.toContain('127.0.0.1');
  });

  it('Timeout hạ tầng -> 504 DEPENDENCY_TIMEOUT', async () => {
    const res = await t.http().get('/api/v1/test-errors/timeout');
    expect(res.status).toBe(504);
    expect(res.body.error.code).toBe('DEPENDENCY_TIMEOUT');
  });

  it('Không gửi X-Request-ID -> tự sinh UUID v4, khớp giữa body và header', async () => {
    const res = await t.http().get('/api/v1/test-errors/app-409');
    expect(res.body.meta.correlationId).toMatch(UUID_V4);
    expect(res.headers['x-request-id']).toBe(res.body.meta.correlationId);
  });
});
