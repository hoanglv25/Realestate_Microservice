import { ApiProperty } from '@nestjs/swagger';

/** Một quận/huyện trong `GET /districts` (`RE.LOCATION/API_Spec.md §1.1`). */
export class DistrictDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty({ format: 'uuid' }) cityId!: string;
  @ApiProperty({ example: 'Hai Bà Trưng' }) name!: string;
}
