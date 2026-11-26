import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { CreateListingDto } from './create-listing.dto';
import { ListMineQuery } from './list-mine.query';
import { RejectListingDto } from './reject-listing.dto';
import { UpdateListingDto } from './update-listing.dto';
import { trim } from './trim';

const valid = {
  title: 'Phòng 25m2 gần ĐH Bách Khoa',
  description: 'Sạch sẽ, có gác lửng',
  propertyType: 'ROOM',
  priceVnd: 3500000,
  depositAmountVnd: 3500000,
  areaM2: 25.5,
  address: '1 Đại Cồ Việt',
  cityId: '0b6d6b9e-4c1f-4d0a-9a51-2f3f3c1d9e11',
  districtId: '5f1c2a7e-7b0e-4f43-8a3d-0e6c9f1b2a33',
  amenities: ['WIFI', 'FRIDGE'],
  lat: 21.0054,
  lng: 105.8431,
};

async function parse<T extends object>(cls: new () => T, plain: Record<string, unknown>) {
  const dto = plainToInstance(cls, plain);
  const errors = await validate(dto, { whitelist: true, forbidNonWhitelisted: true });
  return { dto, fields: errors.map((e) => e.property), errors };
}

describe('CreateListingDto', () => {
  it('hợp lệ (đủ trường)', async () => {
    const { dto, fields } = await parse(CreateListingDto, valid);
    expect(fields).toEqual([]);
    expect(dto).toMatchObject(valid);
  });

  it('chỉ cần các trường bắt buộc; description và amenities tùy chọn', async () => {
    const required: Record<string, unknown> = { ...valid };
    delete required.description;
    delete required.amenities;
    expect((await parse(CreateListingDto, required)).fields).toEqual([]);
  });

  it.each([
    'title',
    'propertyType',
    'priceVnd',
    'depositAmountVnd',
    'areaM2',
    'address',
    'cityId',
    'districtId',
    'lat',
    'lng',
  ])('thiếu %s → lỗi đúng trường đó', async (name) => {
    const plain: Record<string, unknown> = { ...valid };
    delete plain[name];
    expect((await parse(CreateListingDto, plain)).fields).toContain(name);
  });

  it.each([
    ['title 4 ký tự', { title: 'abcd' }, 'title'],
    ['title 201 ký tự', { title: 'a'.repeat(201) }, 'title'],
    ['title chỉ có khoảng trắng', { title: '        ' }, 'title'],
    ['propertyType lạ', { propertyType: 'VILLA' }, 'propertyType'],
    ['priceVnd = 0', { priceVnd: 0 }, 'priceVnd'],
    ['priceVnd âm', { priceVnd: -1 }, 'priceVnd'],
    ['priceVnd có phần thập phân', { priceVnd: 1000.5 }, 'priceVnd'],
    ['priceVnd là chuỗi', { priceVnd: '3500000' }, 'priceVnd'],
    ['depositAmountVnd = 0', { depositAmountVnd: 0 }, 'depositAmountVnd'],
    ['areaM2 = 0', { areaM2: 0 }, 'areaM2'],
    ['areaM2 ba chữ số thập phân', { areaM2: 25.123 }, 'areaM2'],
    ['areaM2 vượt numeric(8,2)', { areaM2: 1000000 }, 'areaM2'],
    ['address trống', { address: '   ' }, 'address'],
    ['address 301 ký tự', { address: 'a'.repeat(301) }, 'address'],
    ['cityId không phải UUID', { cityId: 'Hà Nội' }, 'cityId'],
    ['districtId không phải UUID', { districtId: 'Hai Bà Trưng' }, 'districtId'],
    ['description 5001 ký tự', { description: 'a'.repeat(5001) }, 'description'],
    ['lat > 90', { lat: 90.1 }, 'lat'],
    ['lng < -180', { lng: -180.1 }, 'lng'],
  ])('%s → từ chối', async (_name, patch, field) => {
    expect((await parse(CreateListingDto, { ...valid, ...patch })).fields).toContain(field);
  });

  it('amenities mã lạ → VALIDATION_FAILED nói rõ danh mục', async () => {
    const { errors, fields } = await parse(CreateListingDto, {
      ...valid,
      amenities: ['WIFI', 'SWIMMING_POOL'],
    });
    expect(fields).toEqual(['amenities']);
    expect(JSON.stringify(errors[0].constraints)).toContain('AIR_CONDITIONER');
  });

  it('amenities trùng mã → từ chối', async () => {
    expect(
      (await parse(CreateListingDto, { ...valid, amenities: ['WIFI', 'WIFI'] })).fields,
    ).toContain('amenities');
  });

  it('chấp nhận cả 11 mã tiện ích trong danh mục', async () => {
    const all = [
      'AIR_CONDITIONER',
      'WATER_HEATER',
      'WASHING_MACHINE',
      'FRIDGE',
      'WIFI',
      'PARKING',
      'ELEVATOR',
      'PRIVATE_BATHROOM',
      'BALCONY',
      'FURNISHED',
      'PET_ALLOWED',
    ];
    expect((await parse(CreateListingDto, { ...valid, amenities: all })).fields).toEqual([]);
  });

  it('cắt khoảng trắng hai đầu title, address', async () => {
    const { dto, fields } = await parse(CreateListingDto, {
      ...valid,
      title: '  Phòng đẹp  ',
      address: ' 1 Đại Cồ Việt ',
    });
    expect(fields).toEqual([]);
    expect(dto).toMatchObject({ title: 'Phòng đẹp', address: '1 Đại Cồ Việt' });
  });

  it.each([
    ['city', { city: 'Hà Nội' }],
    ['district', { district: 'Hai Bà Trưng' }],
  ])('v1.5: gửi %s dạng chuỗi (hợp đồng cũ) → trường lạ, từ chối', async (name, patch) => {
    expect((await parse(CreateListingDto, { ...valid, ...patch })).fields).toContain(name);
  });

  it.each(['ownerId', 'status', 'approvalStatus', 'id'])(
    'không nhận %s từ client (chỉ tin JWT, trạng thái do service đặt)',
    async (name) => {
      expect((await parse(CreateListingDto, { ...valid, [name]: 'x' })).fields).toContain(name);
    },
  );
});

describe('UpdateListingDto', () => {
  it('body rỗng qua DTO (service mới chặn "ít nhất một trường")', async () => {
    expect((await parse(UpdateListingDto, {})).fields).toEqual([]);
  });

  it('chỉ gửi một vài trường', async () => {
    expect(
      (await parse(UpdateListingDto, { priceVnd: 4000000, amenities: ['WIFI'] })).fields,
    ).toEqual([]);
  });

  it('vẫn áp ràng buộc của từng trường khi có mặt', async () => {
    expect((await parse(UpdateListingDto, { title: 'abc' })).fields).toContain('title');
    expect((await parse(UpdateListingDto, { priceVnd: 0 })).fields).toContain('priceVnd');
    expect((await parse(UpdateListingDto, { amenities: ['LO_LA'] })).fields).toContain('amenities');
  });

  it('lat và lng đi cùng nhau: gửi một nửa → lỗi ở nửa còn thiếu', async () => {
    expect((await parse(UpdateListingDto, { lat: 21.0 })).fields).toContain('lng');
    expect((await parse(UpdateListingDto, { lng: 105.8 })).fields).toContain('lat');
    expect((await parse(UpdateListingDto, { lat: 21.0, lng: 105.8 })).fields).toEqual([]);
  });

  it('cityId và districtId đi cùng nhau: gửi một nửa → lỗi ở nửa còn thiếu', async () => {
    expect(
      (await parse(UpdateListingDto, { cityId: '0b6d6b9e-4c1f-4d0a-9a51-2f3f3c1d9e11' })).fields,
    ).toContain('districtId');
    expect(
      (await parse(UpdateListingDto, { districtId: '5f1c2a7e-7b0e-4f43-8a3d-0e6c9f1b2a33' }))
        .fields,
    ).toContain('cityId');
    expect(
      (
        await parse(UpdateListingDto, {
          cityId: '0b6d6b9e-4c1f-4d0a-9a51-2f3f3c1d9e11',
          districtId: '5f1c2a7e-7b0e-4f43-8a3d-0e6c9f1b2a33',
        })
      ).fields,
    ).toEqual([]);
  });

  it('lat ngoài khoảng vẫn bị từ chối khi gửi cả đôi', async () => {
    expect((await parse(UpdateListingDto, { lat: 95, lng: 105.8 })).fields).toContain('lat');
  });

  it('không nhận ownerId, status, approvalStatus', async () => {
    for (const name of ['ownerId', 'status', 'approvalStatus']) {
      expect((await parse(UpdateListingDto, { [name]: 'x' })).fields).toContain(name);
    }
  });
});

describe('RejectListingDto', () => {
  it('reason 1–500 ký tự, đã cắt khoảng trắng', async () => {
    const { dto, fields } = await parse(RejectListingDto, { reason: '  Ảnh sai  ' });
    expect(fields).toEqual([]);
    expect(dto.reason).toBe('Ảnh sai');
    expect((await parse(RejectListingDto, { reason: 'a'.repeat(500) })).fields).toEqual([]);
  });

  it.each([[''], ['   '], ['a'.repeat(501)], [undefined], [123]])(
    'reason %p → từ chối',
    async (reason) => {
      expect((await parse(RejectListingDto, { reason })).fields).toContain('reason');
    },
  );
});

describe('ListMineQuery (kế thừa PageQueryDto)', () => {
  it('mặc định page 1, pageSize 20; pageSize tối đa 50', async () => {
    const { dto, fields } = await parse(ListMineQuery, {});
    expect(fields).toEqual([]);
    expect(dto).toMatchObject({ page: 1, pageSize: 20, skip: 0 });
    expect((await parse(ListMineQuery, { pageSize: '51' })).fields).toContain('pageSize');
    expect((await parse(ListMineQuery, { page: '3', pageSize: '10' })).dto.skip).toBe(20);
  });
});

describe('trim', () => {
  it('chỉ cắt chuỗi, giữ nguyên kiểu khác', () => {
    expect(trim({ value: '  a ' })).toBe('a');
    expect(trim({ value: 5 })).toBe(5);
    expect(trim({ value: undefined })).toBeUndefined();
  });
});
