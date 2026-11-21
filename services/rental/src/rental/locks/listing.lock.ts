import { randomBytes } from 'node:crypto';
import type Redis from 'ioredis';
import { depositInProgress } from '../errors/rental.errors';

/** Xóa khóa CHỈ khi giá trị đúng token của mình (nguyên tử trong Redis). */
const RELEASE_LUA = `
if redis.call('GET', KEYS[1]) == ARGV[1] then
  return redis.call('DEL', KEYS[1])
end
return 0
`;

/** Token DI của TTL khóa (`DEPOSIT_LOCK_TTL_MS`). */
export const DEPOSIT_LOCK_TTL = Symbol('DEPOSIT_LOCK_TTL');

/**
 * Khóa Redis theo tin khi đặt cọc (`RE.DEPOSIT_SAGA/API_Spec.md §1` bước 2, `Processing_Flow §2` lớp 1).
 * Chỉ chặn bấm lặp và hai saga cùng tin trên rental; khóa thật là `UPDATE ... WHERE status='AVAILABLE'` ở listing.
 *
 *   lock:listing:{listingId} = <token ngẫu nhiên>   PX = DEPOSIT_LOCK_TTL_MS, NX
 *
 * Nhả bằng Lua so token: saga chạy quá TTL thì khóa đã thuộc người khác, mình không được xóa.
 * Redis dừng khi lấy khóa: lỗi kết nối được bộ lọc lỗi chung map sang `503 DEPENDENCY_UNAVAILABLE`.
 */
export class ListingLock {
  constructor(
    private readonly redis: Pick<Redis, 'set' | 'eval'>,
    private readonly ttlMs: number,
  ) {}

  private key(listingId: string): string {
    return `lock:listing:${listingId}`;
  }

  /** Trả token; khóa đang bị giữ → `409 RENTAL_DEPOSIT_IN_PROGRESS`. */
  async acquire(listingId: string): Promise<string> {
    const token = randomBytes(16).toString('hex');
    const ok = await this.redis.set(this.key(listingId), token, 'PX', this.ttlMs, 'NX');
    if (ok !== 'OK') throw depositInProgress();
    return token;
  }

  /** Không bao giờ ném: lỗi Redis lúc nhả thì khóa tự hết theo TTL, và không được che lỗi gốc của saga. */
  async release(listingId: string, token: string): Promise<void> {
    try {
      await this.redis.eval(RELEASE_LUA, 1, this.key(listingId), token);
    } catch {
      // khóa tự hết sau DEPOSIT_LOCK_TTL_MS
    }
  }
}
