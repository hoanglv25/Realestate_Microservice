import { AppException } from './app.exception';
import { createUuidParamPipe } from './uuid-param.pipe';

describe('createUuidParamPipe', () => {
  const meta = { type: 'param' as const, data: 'id' };
  const ID = '0b0a8b5e-7f9e-4c3a-9d2a-2f5f4b9c1a11';

  it('UUID hợp lệ -> trả nguyên giá trị', async () => {
    await expect(createUuidParamPipe('id').transform(ID, meta)).resolves.toBe(ID);
  });

  it.each(['khong-phai-uuid', '', '123', `${ID}x`, ' ' + ID])(
    'giá trị "%s" -> AppException 400 VALIDATION_FAILED, message "<tên> phải là UUID"',
    async (bad) => {
      const err = await createUuidParamPipe('depositId')
        .transform(bad, meta)
        .catch((e: unknown) => e);
      expect(err).toBeInstanceOf(AppException);
      const e = err as AppException;
      expect(e.getStatus()).toBe(400);
      expect(e.code).toBe('VALIDATION_FAILED');
      expect(e.message).toBe('depositId phải là UUID');
      expect(e.details).toEqual([{ field: 'depositId', errors: ['depositId phải là UUID'] }]);
    },
  );

  it('tên mặc định là "id"', async () => {
    const err = await createUuidParamPipe()
      .transform('x', meta)
      .catch((e: unknown) => e);
    expect((err as AppException).message).toBe('id phải là UUID');
  });
});
