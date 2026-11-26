import { Controller, Get, Query } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Public } from '../../common/auth/public.decorator';
import { PageQueryDto } from '../../common/response/page-query.dto';
import { ApiEnvelope } from '../../common/response/api-envelope.decorator';
import type { Paginated } from '../../common/response/response-meta';
import { CityDto } from '../dto/city.dto';
import { DistrictDto } from '../dto/district.dto';
import { ListDistrictsQuery } from '../dto/list-districts.query';
import { LocationQueryService } from '../services/location-query.service';

/**
 * Danh mục địa giới cho form tạo/sửa tin và bộ lọc tìm kiếm (`RE.LOCATION/API_Spec.md §1`).
 * Công khai (gateway dòng 6a, `RE.GATEWAY` v1.4); chỉ đọc.
 */
@ApiTags('locations')
@Controller()
export class LocationsController {
  constructor(private readonly locations: LocationQueryService) {}

  @Get('cities')
  @Public()
  @ApiOperation({ summary: 'Danh sách tỉnh/thành (danh mục địa giới trước 1/7/2025)' })
  @ApiEnvelope(CityDto, { isArray: true })
  listCities(@Query() query: PageQueryDto): Promise<Paginated<CityDto>> {
    return this.locations.listCities(query.page, query.pageSize);
  }

  @Get('districts')
  @Public()
  @ApiOperation({
    summary: 'Quận/huyện của một tỉnh/thành',
    description:
      'cityId không có trong danh mục → danh sách rỗng. Gọi pageSize=50 để lấy đủ một trang.',
  })
  @ApiEnvelope(DistrictDto, { isArray: true })
  listDistricts(@Query() query: ListDistrictsQuery): Promise<Paginated<DistrictDto>> {
    return this.locations.listDistricts(query.cityId, query.page, query.pageSize);
  }
}
