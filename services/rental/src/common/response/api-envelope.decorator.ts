import { applyDecorators, HttpStatus, Type } from '@nestjs/common';
import {
  ApiExtraModels,
  ApiProperty,
  ApiPropertyOptional,
  ApiResponse,
  getSchemaPath,
} from '@nestjs/swagger';

/** Mô tả `meta` trong Swagger (khớp ResponseMeta). */
export class ResponseMetaDto {
  @ApiProperty({ example: 'abc-123', description: 'ID truy vết, trùng header X-Request-ID' })
  correlationId!: string;

  @ApiProperty({ example: '2026-11-06T10:00:00.000Z', format: 'date-time' })
  timestamp!: string;

  @ApiPropertyOptional({ example: 1, description: 'Chỉ có ở danh sách phân trang' })
  page?: number;

  @ApiPropertyOptional({ example: 20 })
  pageSize?: number;

  @ApiPropertyOptional({ example: 134 })
  total?: number;

  @ApiPropertyOptional({ example: 7 })
  totalPages?: number;
}

export interface ApiEnvelopeOptions {
  /** HTTP status của response (mặc định 200). */
  status?: HttpStatus;
  description?: string;
  /** true: `data` là mảng các `model`. */
  isArray?: boolean;
}

/**
 * Mô tả response thành công trong Swagger theo khung { data, meta }:
 *
 *   @ApiEnvelope(UserDto, { status: 201 })
 *   @ApiEnvelope(ListingDto, { isArray: true })
 *
 * Dùng thay @ApiOkResponse({ type: X }) / @ApiCreatedResponse({ type: X }), vì các decorator đó
 * sẽ mô tả sai (như thể body là X phẳng).
 */
export const ApiEnvelope = (
  model: Type<unknown>,
  options: ApiEnvelopeOptions = {},
): MethodDecorator =>
  applyDecorators(
    ApiExtraModels(ResponseMetaDto, model),
    ApiResponse({
      status: options.status ?? HttpStatus.OK,
      description: options.description,
      schema: {
        type: 'object',
        required: ['data', 'meta'],
        properties: {
          data: options.isArray
            ? { type: 'array', items: { $ref: getSchemaPath(model) } }
            : { $ref: getSchemaPath(model) },
          meta: { $ref: getSchemaPath(ResponseMetaDto) },
        },
      },
    }),
  );
