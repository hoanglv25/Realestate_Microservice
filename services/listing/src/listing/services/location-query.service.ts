import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Paginated } from '../../common/response/response-meta';
import { CityDto } from '../dto/city.dto';
import { DistrictDto } from '../dto/district.dto';
import { City } from '../entities/city.entity';
import { District } from '../entities/district.entity';

/**
 * Đọc danh mục tỉnh/thành, quận/huyện (`RE.LOCATION`). Mỗi danh sách 2 truy vấn (count + data,
 * `findAndCount`), sắp `sort_order ASC, id ASC` (khóa phụ ổn định, `non-functional-standards.md §1`).
 */
@Injectable()
export class LocationQueryService {
  constructor(
    @InjectRepository(City) private readonly cities: Repository<City>,
    @InjectRepository(District) private readonly districts: Repository<District>,
  ) {}

  /** Route 1 `RE.LOCATION`. */
  async listCities(page: number, pageSize: number): Promise<Paginated<CityDto>> {
    const [rows, total] = await this.cities.findAndCount({
      select: { id: true, name: true },
      order: { sortOrder: 'ASC', id: 'ASC' },
      skip: (page - 1) * pageSize,
      take: pageSize,
    });
    return new Paginated(
      rows.map(({ id, name }) => ({ id, name })),
      page,
      pageSize,
      total,
    );
  }

  /** Route 2 `RE.LOCATION`. `cityId` không có trong danh mục → danh sách rỗng (không phải lỗi). */
  async listDistricts(
    cityId: string,
    page: number,
    pageSize: number,
  ): Promise<Paginated<DistrictDto>> {
    const [rows, total] = await this.districts.findAndCount({
      select: { id: true, cityId: true, name: true },
      where: { cityId },
      order: { sortOrder: 'ASC', id: 'ASC' },
      skip: (page - 1) * pageSize,
      take: pageSize,
    });
    return new Paginated(
      rows.map(({ id, cityId: city, name }) => ({ id, cityId: city, name })),
      page,
      pageSize,
      total,
    );
  }

  /**
   * Quận `districtId` có thuộc tỉnh `cityId` không (một câu theo PK). Dùng khi tạo, sửa tin
   * (`RE.LISTING/API_Spec.md §1.2` mục 2a); ném lỗi là việc của bên gọi.
   */
  async isDistrictInCity(cityId: string, districtId: string): Promise<boolean> {
    const rows = await this.districts.query(
      `SELECT 1 FROM districts WHERE id = $1 AND city_id = $2`,
      [districtId, cityId],
    );
    return (rows as unknown[]).length > 0;
  }
}
