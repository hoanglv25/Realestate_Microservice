import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { SearchListingsQuery } from './search-listings.query';

/** Mô phỏng ValidationPipe toàn cục (`transform`, `whitelist`, `forbidNonWhitelisted`) trên query string. */
async function parse(plain: Record<string, unknown>) {
  const query = plainToInstance(SearchListingsQuery, plain);
  const errors = await validate(query, { whitelist: true, forbidNonWhitelisted: true });
  return { query, fields: errors.map((e) => e.property).sort() };
}

describe('SearchListingsQuery (RE.LISTING/API_Spec.md §1.3)', () => {
  it('không tham số: hợp lệ, sort=newest, page 1, pageSize 20', async () => {
    const { query, fields } = await parse({});
    expect(fields).toEqual([]);
    expect(query.sort).toBe('newest');
    expect(query.page).toBe(1);
    expect(query.pageSize).toBe(20);
    expect(query.skip).toBe(0);
  });

  it('ép kiểu từ chuỗi query: số, boolean, CSV tiện ích', async () => {
    const { query, fields } = await parse({
      minPrice: '2000000',
      maxPrice: '5000000',
      minArea: '15.5',
      maxArea: '40',
      cityId: '0b6d6b9e-4c1f-4d0a-9a51-2f3f3c1d9e11',
      districtId: '5f1c2a7e-7b0e-4f43-8a3d-0e6c9f1b2a33',
      amenities: 'WIFI, PARKING',
      available: 'true',
      lat: '21.0054',
      lng: '105.8431',
      radiusKm: '2',
      sort: 'distance',
      page: '2',
      pageSize: '50',
    });
    expect(fields).toEqual([]);
    expect(query).toMatchObject({
      minPrice: 2000000,
      maxPrice: 5000000,
      minArea: 15.5,
      maxArea: 40,
      cityId: '0b6d6b9e-4c1f-4d0a-9a51-2f3f3c1d9e11',
      districtId: '5f1c2a7e-7b0e-4f43-8a3d-0e6c9f1b2a33',
      amenities: ['WIFI', 'PARKING'],
      available: true,
      lat: 21.0054,
      lng: 105.8431,
      radiusKm: 2,
      sort: 'distance',
      page: 2,
      pageSize: 50,
    });
    expect(query.skip).toBe(50);
  });

  it('amenities lặp tham số (?amenities=WIFI&amenities=FRIDGE) cũng nhận', async () => {
    const { query, fields } = await parse({ amenities: ['WIFI', 'FRIDGE,PARKING'] });
    expect(fields).toEqual([]);
    expect(query.amenities).toEqual(['WIFI', 'FRIDGE', 'PARKING']);
  });

  it('amenities rỗng: không lọc', async () => {
    const { query, fields } = await parse({ amenities: '' });
    expect(fields).toEqual([]);
    expect(query.amenities).toEqual([]);
  });

  it('mã tiện ích lạ → 400 ở amenities', async () => {
    expect((await parse({ amenities: 'WIFI,JACUZZI' })).fields).toEqual(['amenities']);
  });

  it('available=false hợp lệ (không lọc), giá trị khác true/false → lỗi', async () => {
    expect((await parse({ available: 'false' })).query.available).toBe(false);
    expect((await parse({ available: 'yes' })).fields).toEqual(['available']);
  });

  describe('bán kính', () => {
    it('lat + lng không radiusKm: hợp lệ (không lọc bán kính, vẫn sort=distance)', async () => {
      const { fields } = await parse({ lat: '21', lng: '105.8', sort: 'distance' });
      expect(fields).toEqual([]);
    });

    it.each([
      ['lat không có lng', { lat: '21' }, ['lng']],
      ['lng không có lat', { lng: '105.8' }, ['lat']],
      ['radiusKm thiếu cả lat và lng', { radiusKm: '2' }, ['lat', 'lng']],
      ['radiusKm chỉ có lat', { radiusKm: '2', lat: '21' }, ['lng']],
      ['sort=distance thiếu lat và lng', { sort: 'distance' }, ['lat', 'lng']],
    ])('%s → 400', async (_name, plain, expected) => {
      expect((await parse(plain)).fields).toEqual(expected);
    });

    it.each(['0', '-1', '50.01', '1000', 'abc'])('radiusKm=%s → 400', async (radiusKm) => {
      expect((await parse({ lat: '21', lng: '105.8', radiusKm })).fields).toEqual(['radiusKm']);
    });

    it.each(['0.1', '2', '50'])('radiusKm=%s hợp lệ', async (radiusKm) => {
      expect((await parse({ lat: '21', lng: '105.8', radiusKm })).fields).toEqual([]);
    });

    it.each([
      ['lat 90.5', { lat: '90.5', lng: '0' }, ['lat']],
      ['lat -90.5', { lat: '-90.5', lng: '0' }, ['lat']],
      ['lng 180.5', { lat: '0', lng: '180.5' }, ['lng']],
      ['lng -180.5', { lat: '0', lng: '-180.5' }, ['lng']],
    ])('toạ độ ngoài miền: %s → 400', async (_name, plain, expected) => {
      expect((await parse(plain)).fields).toEqual(expected);
    });
  });

  describe('khoảng giá, diện tích', () => {
    it('minPrice > maxPrice → 400 ở maxPrice', async () => {
      expect((await parse({ minPrice: '5000000', maxPrice: '1000000' })).fields).toEqual([
        'maxPrice',
      ]);
    });

    it('minPrice = maxPrice hợp lệ (gồm hai đầu)', async () => {
      expect((await parse({ minPrice: '3000000', maxPrice: '3000000' })).fields).toEqual([]);
    });

    it('minArea > maxArea → 400 ở maxArea', async () => {
      expect((await parse({ minArea: '40', maxArea: '10' })).fields).toEqual(['maxArea']);
    });

    it.each([
      ['minPrice âm', { minPrice: '-1' }, 'minPrice'],
      ['minPrice không nguyên', { minPrice: '1.5' }, 'minPrice'],
      ['maxPrice không phải số', { maxPrice: 'abc' }, 'maxPrice'],
      ['minArea âm', { minArea: '-1' }, 'minArea'],
    ])('%s → 400', async (_name, plain, field) => {
      expect((await parse(plain)).fields).toContain(field);
    });
  });

  describe('chuỗi rỗng từ form (`?minPrice=&lat=`): coi như không có, KHÔNG thành 0', () => {
    it.each(['minPrice', 'maxPrice', 'minArea', 'maxArea', 'radiusKm'] as const)(
      '%s rỗng → bỏ qua (undefined), hợp lệ',
      async (name) => {
        const { query, fields } = await parse({ [name]: '' });
        expect(fields).toEqual([]);
        expect(query[name]).toBeUndefined();
      },
    );

    it('lat, lng rỗng cả hai → không có điểm tìm (không rơi về 0,0)', async () => {
      const { query, fields } = await parse({ lat: '', lng: '' });
      expect(fields).toEqual([]);
      expect(query.lat).toBeUndefined();
      expect(query.lng).toBeUndefined();
    });

    it('lat rỗng mà lng có giá trị → 400 ở lat', async () => {
      expect((await parse({ lat: '', lng: '105.8' })).fields).toEqual(['lat']);
    });

    it('radiusKm có giá trị nhưng lat, lng rỗng → 400', async () => {
      expect((await parse({ lat: '', lng: '', radiusKm: '2' })).fields).toEqual(['lat', 'lng']);
    });

    it('sort=distance mà lat, lng rỗng → 400', async () => {
      expect((await parse({ lat: '', lng: '', sort: 'distance' })).fields).toEqual(['lat', 'lng']);
    });
  });

  it('amenities quá nhiều phần tử (lặp mã để phình query) → 400', async () => {
    expect((await parse({ amenities: Array(12).fill('WIFI').join(',') })).fields).toEqual([
      'amenities',
    ]);
    expect((await parse({ amenities: Array(11).fill('WIFI').join(',') })).fields).toEqual([]);
  });

  it('v1.5: cityId, districtId không phải UUID → 400', async () => {
    expect((await parse({ cityId: 'Hà Nội' })).fields).toEqual(['cityId']);
    expect((await parse({ districtId: 'Hai Bà Trưng' })).fields).toEqual(['districtId']);
  });

  it('v1.5: district dạng chuỗi (hợp đồng cũ) → tham số lạ, 400', async () => {
    expect((await parse({ district: 'Hai Bà Trưng' })).fields).toEqual(['district']);
  });

  it.each(['price_asc', 'price_desc', 'newest'])('sort=%s hợp lệ', async (sort) => {
    expect((await parse({ sort })).fields).toEqual([]);
  });

  it('sort lạ → 400', async () => {
    expect((await parse({ sort: 'rating' })).fields).toEqual(['sort']);
  });

  it('pageSize > 50 hoặc page < 1 → 400; tham số lạ → 400', async () => {
    expect((await parse({ pageSize: '51' })).fields).toEqual(['pageSize']);
    expect((await parse({ page: '0' })).fields).toEqual(['page']);
    expect((await parse({ ownerId: 'x' })).fields).toEqual(['ownerId']);
  });
});
