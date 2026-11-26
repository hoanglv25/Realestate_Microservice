import { ApiProperty } from '@nestjs/swagger';
import { IsUUID } from 'class-validator';
import { PageQueryDto } from '../../common/response/page-query.dto';

/**
 * Query của `GET /districts` (`RE.LOCATION/API_Spec.md §1.1`): `cityId` bắt buộc, phân trang
 * `page`, `pageSize` (20, tối đa 50). Sắp xếp cố định `sort_order ASC, id ASC`.
 * `cityId` đúng dạng nhưng không có trong danh mục → danh sách rỗng (không phải lỗi).
 */
export class ListDistrictsQuery extends PageQueryDto {
  @ApiProperty({ format: 'uuid', description: 'Id tỉnh/thành lấy từ GET /cities' })
  @IsUUID(undefined, { message: 'cityId phải là UUID' })
  cityId!: string;
}
