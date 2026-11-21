/** Thông tin phụ đi kèm MỌI response (thành công lẫn lỗi). */
export interface ResponseMeta {
  /** Trùng header X-Request-ID, dùng để truy vết một request qua nhiều service. */
  correlationId: string;
  /** Thời điểm server tạo response, ISO-8601 UTC. */
  timestamp: string;
  // Chỉ có khi handler trả về Paginated
  page?: number;
  pageSize?: number;
  total?: number;
  totalPages?: number;
}

/** Khung response thành công: `data` là kết quả nghiệp vụ, `meta` là thông tin phụ. */
export interface SuccessResponse<T = unknown> {
  data: T;
  meta: ResponseMeta;
}

/**
 * Handler trả kết quả dạng danh sách có phân trang thì trả về class này:
 *
 *   return new Paginated(items, page, pageSize, total);
 *
 * Interceptor đặt `items` vào `data` và đặt page/pageSize/total/totalPages vào `meta`.
 */
export class Paginated<T> {
  constructor(
    readonly items: T[],
    readonly page: number,
    readonly pageSize: number,
    readonly total: number,
  ) {}
}

export function buildMeta(correlationId: string, extra: Partial<ResponseMeta> = {}): ResponseMeta {
  return { correlationId, timestamp: new Date().toISOString(), ...extra };
}
