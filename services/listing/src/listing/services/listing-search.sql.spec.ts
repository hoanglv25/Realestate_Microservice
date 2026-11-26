import { plainToInstance } from 'class-transformer';
import { SearchListingsQuery } from '../dto/search-listings.query';
import { buildSearchSql } from './listing-search.sql';

const query = (plain: Record<string, unknown> = {}): SearchListingsQuery =>
  plainToInstance(SearchListingsQuery, plain);

/** Số thứ tự các `$n` xuất hiện trong câu SQL (không trùng, tăng dần). */
const usedParams = (sql: string): number[] =>
  [...new Set([...sql.matchAll(/\$(\d+)/g)].map((m) => Number(m[1])))].sort((a, b) => a - b);

/** Mọi tham số phải được dùng đúng một lần ít nhất và liền nhau từ $1: pg báo lỗi nếu có `$n` mồ côi. */
const expectParamsMatch = (sql: string, params: unknown[]): void => {
  expect(usedParams(sql)).toEqual(params.map((_, i) => i + 1));
};

describe('buildSearchSql (RE.LISTING/API_Spec.md §1.3)', () => {
  describe('điều kiện nền', () => {
    it('luôn chỉ tin APPROVED, chưa xóa, không HIDDEN, ở cả count và data', () => {
      const built = buildSearchSql(query());
      for (const sql of [built.countSql, built.dataSql]) {
        expect(sql).toContain(`l.approval_status = 'APPROVED'`);
        expect(sql).toContain('l.deleted_at IS NULL');
        expect(sql).toContain(`l.status <> 'HIDDEN'`);
      }
    });

    it('không bộ lọc: count không có tham số, data chỉ có LIMIT, OFFSET', () => {
      const built = buildSearchSql(query({ page: '3', pageSize: '10' }));
      expect(built.countParams).toEqual([]);
      expect(built.dataParams).toEqual([10, 20]);
      expectParamsMatch(built.countSql, built.countParams);
      expectParamsMatch(built.dataSql, built.dataParams);
      expect(built.dataSql).toMatch(/LIMIT \$1 OFFSET \$2/);
    });

    it('count và data dùng CÙNG mệnh đề WHERE (total khớp tập trả về)', () => {
      const built = buildSearchSql(
        query({
          minPrice: '1',
          maxArea: '50',
          districtId: '5f1c2a7e-7b0e-4f43-8a3d-0e6c9f1b2a33',
          amenities: 'WIFI',
        }),
      );
      // WHERE ngoài cùng là WHERE cuối (truy vấn con LATERAL của ảnh bìa nằm trước nó)
      const where = (sql: string) =>
        sql
          .slice(sql.lastIndexOf('WHERE ') + 'WHERE '.length)
          .split(/ ORDER BY | LIMIT /)[0]
          .trim();
      expect(where(built.dataSql)).toBe(where(built.countSql));
      expect(built.dataParams.slice(0, built.countParams.length)).toEqual(built.countParams);
    });

    it('count không join ảnh (chỉ data có ảnh bìa)', () => {
      const built = buildSearchSql(query());
      expect(built.countSql).not.toContain('listing_images');
      expect(built.dataSql).toContain('LEFT JOIN LATERAL');
      expect(built.dataSql).toContain('listing_images');
    });
  });

  describe('bộ lọc', () => {
    it('giá, diện tích: gồm cả hai đầu, tham số hóa', () => {
      const built = buildSearchSql(
        query({ minPrice: '2000000', maxPrice: '5000000', minArea: '15', maxArea: '40' }),
      );
      expect(built.countSql).toContain('l.price_vnd >= $1');
      expect(built.countSql).toContain('l.price_vnd <= $2');
      expect(built.countSql).toContain('l.area_m2 >= $3');
      expect(built.countSql).toContain('l.area_m2 <= $4');
      expect(built.countParams).toEqual([2000000, 5000000, 15, 40]);
      expectParamsMatch(built.countSql, built.countParams);
    });

    it('minPrice = 0 vẫn là bộ lọc hợp lệ (không bị bỏ vì falsy)', () => {
      const built = buildSearchSql(query({ minPrice: '0' }));
      expect(built.countSql).toContain('l.price_vnd >= $1');
      expect(built.countParams).toEqual([0]);
    });

    it('v1.5: cityId, districtId so khớp cột id, giá trị chỉ nằm ở tham số', () => {
      const built = buildSearchSql(
        query({
          cityId: '0b6d6b9e-4c1f-4d0a-9a51-2f3f3c1d9e11',
          districtId: '5f1c2a7e-7b0e-4f43-8a3d-0e6c9f1b2a33',
        }),
      );
      expect(built.countSql).toContain('l.city_id = $1');
      expect(built.countSql).toContain('l.district_id = $2');
      expect(built.countSql).not.toContain('0b6d6b9e-4c1f-4d0a-9a51-2f3f3c1d9e11');
      expect(built.countParams).toEqual([
        '0b6d6b9e-4c1f-4d0a-9a51-2f3f3c1d9e11',
        '5f1c2a7e-7b0e-4f43-8a3d-0e6c9f1b2a33',
      ]);
    });

    it('amenities: mọi tiện ích phải có (@>)', () => {
      const built = buildSearchSql(query({ amenities: 'WIFI,PARKING' }));
      expect(built.countSql).toContain('l.amenities @> $1::text[]');
      expect(built.countParams).toEqual([['WIFI', 'PARKING']]);
    });

    it('amenities rỗng: không thêm điều kiện', () => {
      const built = buildSearchSql(query({ amenities: '' }));
      expect(built.countSql).not.toContain('amenities');
      expect(built.countParams).toEqual([]);
    });

    it('available=true thêm status = AVAILABLE; false hoặc không có thì không', () => {
      expect(buildSearchSql(query({ available: 'true' })).countSql).toContain(
        `l.status = 'AVAILABLE'`,
      );
      expect(buildSearchSql(query({ available: 'false' })).countSql).not.toContain(
        `l.status = 'AVAILABLE'`,
      );
      expect(buildSearchSql(query()).countSql).not.toContain(`l.status = 'AVAILABLE'`);
    });
  });

  describe('bán kính và khoảng cách', () => {
    it('có radiusKm: ST_DWithin (mét) ở cả count và data, distanceM ở data', () => {
      const built = buildSearchSql(query({ lat: '21.0054', lng: '105.8431', radiusKm: '2' }));
      expect(built.countSql).toContain('ST_DWithin(l.location,');
      expect(built.dataSql).toContain('ST_DWithin(l.location,');
      expect(built.countSql).not.toContain('ST_Distance');
      expect(built.dataSql).toContain('ST_Distance(l.location,');
      expect(built.dataSql).toContain('"distanceM"');
      expect(built.countParams).toEqual([105.8431, 21.0054, 2000]);
      expectParamsMatch(built.countSql, built.countParams);
      expectParamsMatch(built.dataSql, built.dataParams);
    });

    it('ST_MakePoint theo thứ tự (lng, lat)', () => {
      const built = buildSearchSql(query({ lat: '21', lng: '105', radiusKm: '1' }));
      expect(built.countParams.slice(0, 2)).toEqual([105, 21]);
      expect(built.countSql).toContain('ST_MakePoint($1, $2)');
    });

    it('lat/lng không radiusKm: KHÔNG lọc bán kính, vẫn có distanceM', () => {
      const built = buildSearchSql(query({ lat: '21', lng: '105' }));
      expect(built.countSql).not.toContain('ST_DWithin');
      expect(built.countParams).toEqual([]);
      expect(built.dataSql).not.toContain('ST_DWithin');
      expect(built.dataSql).toContain('"distanceM"');
      expectParamsMatch(built.countSql, built.countParams);
      expectParamsMatch(built.dataSql, built.dataParams);
    });

    it('không lat/lng: không có distanceM, không ST_*', () => {
      const built = buildSearchSql(query());
      expect(built.dataSql).not.toContain('distanceM');
      expect(built.dataSql).not.toContain('ST_Distance');
      expect(built.dataSql).not.toContain('ST_DWithin');
    });

    it('bán kính 0.1 km = 100 mét', () => {
      expect(
        buildSearchSql(query({ lat: '21', lng: '105', radiusKm: '0.1' })).countParams[2],
      ).toBeCloseTo(100);
    });
  });

  describe('sắp xếp (luôn có khóa phụ ổn định)', () => {
    // ORDER BY ngoài cùng là ORDER BY cuối (truy vấn con LATERAL của ảnh bìa có ORDER BY riêng)
    const orderBy = (plain: Record<string, unknown>) => {
      const { dataSql } = buildSearchSql(query(plain));
      return dataSql
        .slice(dataSql.lastIndexOf('ORDER BY ') + 'ORDER BY '.length)
        .split(/ LIMIT /)[0]
        .trim();
    };

    it('newest (mặc định)', () => {
      expect(orderBy({})).toBe('l.created_at DESC, l.id DESC');
      expect(orderBy({ sort: 'newest' })).toBe('l.created_at DESC, l.id DESC');
    });

    it('price_asc, price_desc', () => {
      expect(orderBy({ sort: 'price_asc' })).toBe('l.price_vnd ASC, l.created_at DESC, l.id DESC');
      expect(orderBy({ sort: 'price_desc' })).toBe(
        'l.price_vnd DESC, l.created_at DESC, l.id DESC',
      );
    });

    it('distance: khoảng cách tăng dần rồi id', () => {
      expect(orderBy({ sort: 'distance', lat: '21', lng: '105' })).toBe(
        'ST_Distance(l.location, ST_SetSRID(ST_MakePoint($1, $2), 4326)::geography) ASC, l.id ASC',
      );
    });
  });

  describe('phân trang', () => {
    it('LIMIT, OFFSET là hai tham số cuối của data (sau cả tham số điểm)', () => {
      const built = buildSearchSql(
        query({ lat: '21', lng: '105', radiusKm: '2', page: '2', pageSize: '30' }),
      );
      expect(built.dataParams.slice(-2)).toEqual([30, 30]);
      expectParamsMatch(built.dataSql, built.dataParams);
    });

    it('tổ hợp đầy đủ: mọi $n đều được dùng, count không thừa tham số của data', () => {
      const built = buildSearchSql(
        query({
          minPrice: '1',
          maxPrice: '9',
          minArea: '2',
          maxArea: '8',
          cityId: '0b6d6b9e-4c1f-4d0a-9a51-2f3f3c1d9e11',
          districtId: '5f1c2a7e-7b0e-4f43-8a3d-0e6c9f1b2a33',
          amenities: 'WIFI,FRIDGE',
          available: 'true',
          lat: '21',
          lng: '105',
          radiusKm: '5',
          sort: 'distance',
        }),
      );
      expectParamsMatch(built.countSql, built.countParams);
      expectParamsMatch(built.dataSql, built.dataParams);
      expect(built.dataParams.length).toBe(built.countParams.length + 2);
    });
  });

  it('chọn đúng các cột của ListingSummaryDto, không có description hay approval_status', () => {
    const { dataSql } = buildSearchSql(query());
    expect(dataSql).toContain('"coverKey"');
    expect(dataSql).toContain('"createdAt"');
    expect(dataSql).not.toContain('l.description');
    expect(dataSql).not.toContain('reject_reason');
    expect(dataSql).not.toMatch(/AS "approvalStatus"/);
  });

  it('v1.5: có cityId, districtId và tên tỉnh, quận bằng truy vấn con theo PK (không cột chuỗi cũ)', () => {
    const { dataSql } = buildSearchSql(query());
    expect(dataSql).toContain('l.city_id AS "cityId"');
    expect(dataSql).toContain('l.district_id AS "districtId"');
    expect(dataSql).toContain('(SELECT c.name FROM cities c WHERE c.id = l.city_id) AS city');
    expect(dataSql).toContain(
      '(SELECT d.name FROM districts d WHERE d.id = l.district_id) AS district',
    );
    expect(dataSql).not.toMatch(/l\.district,|l\.city,/);
  });
});
