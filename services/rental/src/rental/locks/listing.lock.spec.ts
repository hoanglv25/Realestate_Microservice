import { ListingLock } from './listing.lock';

function fakeRedis() {
  const store = new Map<string, string>();
  return {
    store,
    set: jest.fn(async (key: string, value: string, px: string, ttl: number, nx: string) => {
      expect([px, nx]).toEqual(['PX', 'NX']);
      expect(ttl).toBe(10_000);
      if (store.has(key)) return null;
      store.set(key, value);
      return 'OK';
    }),
    eval: jest.fn(async (_lua: string, _n: number, key: string, token: string) => {
      if (store.get(key) !== token) return 0;
      store.delete(key);
      return 1;
    }),
  };
}

describe('ListingLock', () => {
  it('acquire: SET lock:listing:{id} <token> PX ttl NX; trả token ngẫu nhiên', async () => {
    const redis = fakeRedis();
    const lock = new ListingLock(redis as never, 10_000);
    const token = await lock.acquire('L1');
    expect(typeof token).toBe('string');
    expect(token.length).toBeGreaterThanOrEqual(16);
    expect(redis.store.get('lock:listing:L1')).toBe(token);
  });

  it('khóa đang bị giữ -> 409 RENTAL_DEPOSIT_IN_PROGRESS (BR-06)', async () => {
    const redis = fakeRedis();
    const lock = new ListingLock(redis as never, 10_000);
    await lock.acquire('L1');
    await expect(lock.acquire('L1')).rejects.toMatchObject({
      code: 'RENTAL_DEPOSIT_IN_PROGRESS',
      status: 409,
    });
  });

  it('release chỉ xóa khi đúng token (không xóa khóa của người khác đã lấy sau khi khóa mình hết hạn)', async () => {
    const redis = fakeRedis();
    const lock = new ListingLock(redis as never, 10_000);
    const mine = await lock.acquire('L1');
    redis.store.set('lock:listing:L1', 'token-cua-nguoi-khac');
    await lock.release('L1', mine);
    expect(redis.store.get('lock:listing:L1')).toBe('token-cua-nguoi-khac');
    await lock.release('L1', 'token-cua-nguoi-khac');
    expect(redis.store.has('lock:listing:L1')).toBe(false);
  });

  it('release lỗi Redis -> không ném (khóa tự hết theo TTL), để không che lỗi gốc của saga', async () => {
    const redis = fakeRedis();
    redis.eval.mockRejectedValue(new Error('redis down'));
    const lock = new ListingLock(redis as never, 10_000);
    await expect(lock.release('L1', 't')).resolves.toBeUndefined();
  });
});
