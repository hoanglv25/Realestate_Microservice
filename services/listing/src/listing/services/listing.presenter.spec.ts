import { DataSource } from 'typeorm';
import { StorageService } from '../../storage/storage.service';
import { SearchRow } from './listing-search.sql';
import { ListingPresenter } from './listing.presenter';
import { ListingRow } from './listing.sql';

const row = (id: string): ListingRow => ({
  id,
  ownerId: 'owner-1',
  title: `Tin ${id}`,
  description: null,
  propertyType: 'ROOM',
  priceVnd: 3500000,
  depositAmountVnd: 3500000,
  areaM2: 25.5,
  address: '1 Đại Cồ Việt',
  cityId: '0b6d6b9e-4c1f-4d0a-9a51-2f3f3c1d9e11',
  city: 'Hà Nội',
  districtId: '5f1c2a7e-7b0e-4f43-8a3d-0e6c9f1b2a33',
  district: 'Hai Bà Trưng',
  amenities: ['WIFI'],
  lat: 21.0054,
  lng: 105.8431,
  status: 'AVAILABLE',
  approvalStatus: 'APPROVED',
  rejectReason: null,
  createdAt: new Date('2026-11-19T01:00:00.000Z'),
  updatedAt: new Date('2026-11-19T02:00:00.000Z'),
});

function make(images: Array<Record<string, unknown>>) {
  const query = jest.fn().mockResolvedValue(images);
  const presignGet = jest.fn(
    async (bucket: string, key: string) => `https://s3/${bucket}/${key}?sig`,
  );
  const presenter = new ListingPresenter(
    { query } as unknown as DataSource,
    { presignGet } as unknown as StorageService,
  );
  return { presenter, query, presignGet };
}

describe('ListingPresenter', () => {
  it('không có tin: trả [] và không truy vấn', async () => {
    const { presenter, query } = make([]);
    await expect(presenter.present([])).resolves.toEqual([]);
    expect(query).not.toHaveBeenCalled();
  });

  it('một truy vấn ảnh cho cả trang, gom ảnh về đúng tin, giữ thứ tự DB trả về', async () => {
    const { presenter, query } = make([
      { id: 'i1', listingId: 'a', objectKey: 'listings/a/1.png', sortOrder: 0 },
      { id: 'i2', listingId: 'b', objectKey: 'listings/b/1.png', sortOrder: 0 },
      { id: 'i3', listingId: 'a', objectKey: 'listings/a/2.png', sortOrder: 1 },
    ]);
    const [a, b, c] = await presenter.present([row('a'), row('b'), row('c')]);

    expect(query).toHaveBeenCalledTimes(1);
    expect(query.mock.calls[0][1]).toEqual([['a', 'b', 'c']]);
    expect(a.images.map((i) => i.id)).toEqual(['i1', 'i3']);
    expect(b.images.map((i) => i.id)).toEqual(['i2']);
    expect(c.images).toEqual([]);
  });

  it('url ảnh là presigned GET của bucket listing-images; không lộ object key hay trường nội bộ', async () => {
    const { presenter, presignGet } = make([
      { id: 'i1', listingId: 'a', objectKey: 'listings/a/1.png', sortOrder: 0 },
    ]);
    const [dto] = await presenter.present([row('a')]);
    expect(presignGet).toHaveBeenCalledWith('listing-images', 'listings/a/1.png');
    expect(dto.images).toEqual([
      { id: 'i1', url: 'https://s3/listing-images/listings/a/1.png?sig', sortOrder: 0 },
    ]);
    expect(JSON.stringify(dto)).not.toContain('objectKey');
  });

  describe('presentSummaries (kết quả tìm kiếm, ListingSummaryDto)', () => {
    const summary = (id: string, over: Partial<SearchRow> = {}): SearchRow => ({
      id,
      ownerId: 'owner-1',
      title: `Tin ${id}`,
      propertyType: 'ROOM',
      priceVnd: 3500000,
      depositAmountVnd: 3500000,
      areaM2: 25.5,
      address: '1 Đại Cồ Việt',
      cityId: '0b6d6b9e-4c1f-4d0a-9a51-2f3f3c1d9e11',
      city: 'Hà Nội',
      districtId: '5f1c2a7e-7b0e-4f43-8a3d-0e6c9f1b2a33',
      district: 'Hai Bà Trưng',
      amenities: ['WIFI'],
      lat: 21.0054,
      lng: 105.8431,
      status: 'AVAILABLE',
      createdAt: new Date('2026-11-19T01:00:00.000Z'),
      coverKey: null,
      ...over,
    });

    it('không có kết quả: [] và không truy vấn', async () => {
      const { presenter, query } = make([]);
      await expect(presenter.presentSummaries([])).resolves.toEqual([]);
      expect(query).not.toHaveBeenCalled();
    });

    it('ảnh bìa: presigned GET của bucket listing-images; chưa có ảnh thì null; KHÔNG truy vấn DB', async () => {
      const { presenter, query, presignGet } = make([]);
      const [withCover, noCover] = await presenter.presentSummaries([
        summary('a', { coverKey: 'listings/a/1.png' }),
        summary('b'),
      ]);
      expect(presignGet).toHaveBeenCalledTimes(1);
      expect(presignGet).toHaveBeenCalledWith('listing-images', 'listings/a/1.png');
      expect(withCover.coverImageUrl).toBe('https://s3/listing-images/listings/a/1.png?sig');
      expect(noCover.coverImageUrl).toBeNull();
      expect(query).not.toHaveBeenCalled();
    });

    it('distanceM chỉ có khi dòng có khoảng cách; không lộ coverKey', async () => {
      const { presenter } = make([]);
      const [near, plain] = await presenter.presentSummaries([
        summary('a', { distanceM: 350 }),
        summary('b'),
      ]);
      expect(near.distanceM).toBe(350);
      expect(plain).not.toHaveProperty('distanceM');
      expect(JSON.stringify(near)).not.toContain('coverKey');
      expect(near.createdAt).toBe('2026-11-19T01:00:00.000Z');
    });

    it('không có description, approvalStatus, rejectReason, images, updatedAt', async () => {
      const { presenter } = make([]);
      const [dto] = await presenter.presentSummaries([summary('a')]);
      for (const field of [
        'description',
        'approvalStatus',
        'rejectReason',
        'images',
        'updatedAt',
      ]) {
        expect(dto).not.toHaveProperty(field);
      }
    });
  });

  it('thời gian ra ISO 8601 UTC; các trường khác giữ nguyên', async () => {
    const { presenter } = make([]);
    const [dto] = await presenter.present([row('a')]);
    expect(dto).toMatchObject({
      id: 'a',
      priceVnd: 3500000,
      lat: 21.0054,
      createdAt: '2026-11-19T01:00:00.000Z',
      updatedAt: '2026-11-19T02:00:00.000Z',
    });
  });
});
