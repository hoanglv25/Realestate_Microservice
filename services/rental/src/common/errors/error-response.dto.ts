import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { ResponseMetaDto } from '../response/api-envelope.decorator';

/** Phần `error` của response lỗi (khớp ErrorBody trong all-exceptions.filter.ts). */
export class ErrorBodyDto {
  @ApiProperty({
    example: 'EXAMPLE_NAME_TAKEN',
    description: 'Mã lỗi ổn định, client dựa vào đây để xử lý',
  })
  code!: string;

  @ApiProperty({ example: 'Tên đã tồn tại', description: 'Thông điệp cho người đọc' })
  message!: string;

  @ApiPropertyOptional({ description: 'Dữ liệu bổ sung (lỗi từng trường, id liên quan...)' })
  details?: unknown;
}

/** Mô tả format lỗi thống nhất trong Swagger: { error, meta } (khớp ErrorResponse trong all-exceptions.filter.ts). */
export class ErrorResponseDto {
  @ApiProperty({ type: ErrorBodyDto })
  error!: ErrorBodyDto;

  @ApiProperty({ type: ResponseMetaDto })
  meta!: ResponseMetaDto;
}
