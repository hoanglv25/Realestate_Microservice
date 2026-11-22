import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsInt, Max, Min } from 'class-validator';

export const DEFAULT_PAGE_SIZE = 20;
export const MAX_PAGE_SIZE = 50;

/**
 * Query phân trang dùng chung cho API danh sách (`non-functional-standards.md §1`).
 * DTO riêng của từng API kế thừa class này và thêm bộ lọc của nó.
 * Handler trả `new Paginated(items, query.page, query.pageSize, total)`.
 */
export class PageQueryDto {
  @ApiPropertyOptional({ type: 'integer', minimum: 1, default: 1 })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page: number = 1;

  @ApiPropertyOptional({
    type: 'integer',
    minimum: 1,
    maximum: MAX_PAGE_SIZE,
    default: DEFAULT_PAGE_SIZE,
  })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(MAX_PAGE_SIZE)
  pageSize: number = DEFAULT_PAGE_SIZE;

  /** Số dòng bỏ qua cho `OFFSET`/`skip`. */
  get skip(): number {
    return (this.page - 1) * this.pageSize;
  }
}
