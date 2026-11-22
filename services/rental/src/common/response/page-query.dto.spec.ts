import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { PageQueryDto } from './page-query.dto';

async function parse(plain: Record<string, unknown>) {
  const dto = plainToInstance(PageQueryDto, plain);
  const errors = await validate(dto, { whitelist: true, forbidNonWhitelisted: true });
  return { dto, errors };
}

describe('PageQueryDto', () => {
  it('không truyền gì thì page=1, pageSize=20', async () => {
    const { dto, errors } = await parse({});
    expect(errors).toHaveLength(0);
    expect(dto.page).toBe(1);
    expect(dto.pageSize).toBe(20);
  });

  it('ép chuỗi query "3" và "50" thành số', async () => {
    const { dto, errors } = await parse({ page: '3', pageSize: '50' });
    expect(errors).toHaveLength(0);
    expect(dto.page).toBe(3);
    expect(dto.pageSize).toBe(50);
  });

  it.each([
    ['page=0', { page: '0' }],
    ['page âm', { page: '-1' }],
    ['page không phải số nguyên', { page: '1.5' }],
    ['page là chữ', { page: 'abc' }],
    ['pageSize=0', { pageSize: '0' }],
    ['pageSize=51 vượt tối đa', { pageSize: '51' }],
    ['pageSize là chữ', { pageSize: 'abc' }],
  ])('từ chối %s', async (_name, plain) => {
    const { errors } = await parse(plain);
    expect(errors.length).toBeGreaterThan(0);
  });

  it('skip = (page - 1) * pageSize', async () => {
    expect((await parse({})).dto.skip).toBe(0);
    expect((await parse({ page: '3', pageSize: '10' })).dto.skip).toBe(20);
  });
});
