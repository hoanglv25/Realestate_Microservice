import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { ListDistrictsQuery } from './list-districts.query';

/** Mô phỏng ValidationPipe toàn cục (`transform`, `whitelist`, `forbidNonWhitelisted`) trên query string. */
async function parse(plain: Record<string, unknown>) {
  const query = plainToInstance(ListDistrictsQuery, plain);
  const errors = await validate(query, { whitelist: true, forbidNonWhitelisted: true });
  return { query, fields: errors.map((e) => e.property).sort() };
}

const CITY_ID = '0b6d6b9e-4c1f-4d0a-9a51-2f3f3c1d9e11';

describe('ListDistrictsQuery (RE.LOCATION/API_Spec.md §1.1, §1.2; test 5)', () => {
  it('cityId hợp lệ: page 1, pageSize 20 mặc định', async () => {
    const { query, fields } = await parse({ cityId: CITY_ID });
    expect(fields).toEqual([]);
    expect(query).toMatchObject({ cityId: CITY_ID, page: 1, pageSize: 20 });
  });

  it('ép kiểu page, pageSize từ chuỗi; pageSize 50 hợp lệ', async () => {
    const { query, fields } = await parse({ cityId: CITY_ID, page: '2', pageSize: '50' });
    expect(fields).toEqual([]);
    expect(query.skip).toBe(50);
  });

  it.each([
    ['thiếu cityId', {}, ['cityId']],
    ['cityId không phải UUID', { cityId: 'abc' }, ['cityId']],
    ['pageSize 51', { cityId: CITY_ID, pageSize: '51' }, ['pageSize']],
    ['page 0', { cityId: CITY_ID, page: '0' }, ['page']],
    ['tham số lạ', { cityId: CITY_ID, district: 'Ba Đình' }, ['district']],
  ])('%s → lỗi đúng trường', async (_name, plain, expected) => {
    const { fields } = await parse(plain);
    expect(fields).toEqual(expected);
  });
});
