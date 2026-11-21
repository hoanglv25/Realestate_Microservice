import { Body, Controller, Get, Post } from '@nestjs/common';
import {
  ApiConflictResponse,
  ApiExcludeController,
  ApiOkResponse,
  ApiProperty,
  ApiTags,
} from '@nestjs/swagger';
import { IsInt, Min } from 'class-validator';
import { Public } from '../src/common/auth/public.decorator';
import { ErrorResponseDto } from '../src/common/errors/error-response.dto';
import { createTestApp, TestApp } from './helpers/create-test-app';

// Controller riêng của test (KHÔNG dùng module mẫu src/example) để spec này vẫn xanh
// sau khi service thật xóa module mẫu.
class PriceDto {
  @ApiProperty({ type: 'integer', minimum: 0, description: 'VND, số nguyên' })
  @IsInt()
  @Min(0)
  priceVnd!: number;
}

@Public()
@ApiTags('swagger-test')
@Controller('swagger-test')
class SwaggerTestController {
  @Post()
  @ApiOkResponse({ type: PriceDto })
  @ApiConflictResponse({ type: ErrorResponseDto })
  create(@Body() dto: PriceDto): PriceDto {
    return dto;
  }
}

@Public()
@ApiExcludeController()
@Controller('internal/swagger-test')
class SwaggerInternalController {
  @Get()
  ping(): { ok: boolean } {
    return { ok: true };
  }
}

describe('Swagger /api/docs', () => {
  let t: TestApp;

  beforeAll(async () => {
    t = await createTestApp([SwaggerTestController, SwaggerInternalController], [], {
      swagger: true,
    });
  });
  afterAll(async () => {
    await t.app.close();
  });

  it('/api/docs trả giao diện Swagger UI mà không cần token', async () => {
    const res = await t.http().get('/api/docs');
    expect(res.status).toBe(200);
    expect(res.text.toLowerCase()).toContain('swagger');
  });

  it('/api/docs-json mô tả API công khai, loại trừ /internal, có schema lỗi và bearer auth', async () => {
    const res = await t.http().get('/api/docs-json');
    expect(res.status).toBe(200);
    const doc = res.body;
    expect(doc.info.title).toBe('template-nest-test API');
    expect(Object.keys(doc.paths)).toEqual(
      expect.arrayContaining(['/api/v1/swagger-test', '/api/v1/health']),
    );
    expect(Object.keys(doc.paths).some((p) => p.includes('/internal'))).toBe(false);
    expect(Object.keys(doc.components.schemas)).toEqual(
      expect.arrayContaining(['PriceDto', 'ErrorResponseDto']),
    );
    expect(doc.components.securitySchemes.bearer).toMatchObject({ type: 'http', scheme: 'bearer' });
  });

  it('tiền trong OpenAPI là integer, không phải number thập phân', async () => {
    const doc = (await t.http().get('/api/docs-json')).body;
    expect(doc.components.schemas.PriceDto.properties.priceVnd.type).toBe('integer');
  });
});
