/**
 * TypeORM + pg trả `[rows, rowCount]` cho `UPDATE ... RETURNING` (khác `INSERT ... RETURNING`: trả thẳng `rows`).
 * Bản riêng của payment (rental có hàm cùng ý trong `viewing.service.ts`, không import chéo service).
 */
export function updatedRows<T>(result: unknown): T[] {
  return (Array.isArray(result) && Array.isArray(result[0]) ? result[0] : []) as T[];
}
