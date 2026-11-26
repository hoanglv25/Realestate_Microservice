import { ApiProperty } from '@nestjs/swagger';

/** Một tỉnh/thành trong `GET /cities` (`RE.LOCATION/API_Spec.md §1.1`). */
export class CityDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty({ example: 'Hà Nội' }) name!: string;
}
