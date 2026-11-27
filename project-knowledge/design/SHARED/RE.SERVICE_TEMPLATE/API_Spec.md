# RE.SERVICE_TEMPLATE — Đặc tả API

| | |
|---|---|
| **Mã chức năng** | `RE.SERVICE_TEMPLATE` — khung kỹ thuật dùng chung, mọi service copy từ đây |
| **Service** | `services/_template-nest` (`@realestate/template-nest`, cổng 3000 khi chạy thử) |
| **Quy tắc** | Không có `BR-xx`; hiện thực NFR02, NFR03, NFR06 |
| **Quyết định** | ADR-0011, ADR-0013, ADR-0014 |
| **CSDL** | Tùy chọn: bật khi có `DATABASE_URL` |
| **Chủ sở hữu / Cập nhật / Phiên bản** | hoang.lv — 2026-11-26 — v2.2 |

> Mô tả hợp đồng mà template **đã có trong code**. Nguồn: `services/_template-nest/README.md`. Mọi service kế thừa nguyên các hợp đồng này.

## 1. Endpoint có sẵn

| Method, đường dẫn | Quyền | Kết quả |
|---|---|---|
| `GET /health` | public, không qua gateway | `200`/`503`, body phẳng `{ status, service, version, uptime, checks }` |
| `GET /api/v1/health` | public | Alias của `/health` |
| `GET /api/docs` | public, chỉ khi `SWAGGER_ENABLED=true` | Swagger UI |

`checks` có khóa theo module đang bật: `db`, `redis`, `rabbitmq`, `s3`.

## 2. Hợp đồng response

Theo `standards/api-convention.md §4–5`. Do `ResponseEnvelopeInterceptor` và `AllExceptionsFilter` dựng.

| Tình huống | Status | `error.code` |
|---|---|---|
| DTO sai | 400 | `VALIDATION_FAILED`, `details` theo trường |
| Tham số đường dẫn không phải UUID (v2.0) | 400 | `VALIDATION_FAILED`, message "<tên> phải là UUID", `details: [{ field, errors }]` |
| Body không đọc được (JSON sai cú pháp) | 400 | `BAD_REQUEST` |
| Thiếu token | 401 | `AUTH_TOKEN_MISSING` |
| Token sai chữ ký | 401 | `AUTH_TOKEN_INVALID` |
| Token hết hạn | 401 | `AUTH_TOKEN_EXPIRED` |
| Thiếu vai trò | 403 | `FORBIDDEN_ROLE` |
| Chưa cấu hình JWT | 503 | `AUTH_NOT_CONFIGURED` |
| Thiếu `Idempotency-Key` ở route `@Idempotent()` | 400 | `IDEMPOTENCY_KEY_REQUIRED` |
| Cùng khóa, khác body | 422 | `IDEMPOTENCY_KEY_REUSED` |
| Cùng khóa, lần đầu chưa xong | 409 | `IDEMPOTENCY_IN_PROGRESS` |
| Chưa bật Redis cho idempotency | 503 | `IDEMPOTENCY_UNAVAILABLE` |
| DB/Redis/RabbitMQ không kết nối được | 503 | `DEPENDENCY_UNAVAILABLE` |
| DB/Redis quá hạn | 504 | `DEPENDENCY_TIMEOUT` |
| Service khác không kết nối được | 503 | `UPSTREAM_UNAVAILABLE` |
| Service khác quá hạn | 504 | `UPSTREAM_TIMEOUT` |
| Lỗi không lường trước | 500 | `INTERNAL_ERROR`, không lộ stack |

## 3. `InternalHttpService` — hợp đồng gọi service khác

```ts
get<T>(url, options?): Promise<T>
post<T>(url, body, options?): Promise<T>
put<T>(url, body, options?): Promise<T>
delete<T>(url, options?): Promise<T>
// options: { timeoutMs?: number; idempotent?: boolean; headers?: Record<string,string> }
```

| Hành vi | Giá trị |
|---|---|
| Header tự gắn | `X-Request-ID` của request gốc |
| Timeout | `options.timeoutMs` hoặc `HTTP_TIMEOUT_MS` |
| Thử lại | `GET/HEAD/OPTIONS/PUT/DELETE` luôn; `POST` khi `idempotent: true` |
| Điều kiện thử lại | Timeout, mất kết nối, upstream `502/503/504`; tối đa `HTTP_MAX_RETRIES` lần, backoff 100 × 2ⁿ ms |
| Thành công | Trả `data` của envelope |
| Upstream `4xx` | Ném `AppException` giữ nguyên status và `error.code` |
| Hết lượt | `503 UPSTREAM_UNAVAILABLE` hoặc `504 UPSTREAM_TIMEOUT`; `details.outcome = 'NOT_EXECUTED'` chỉ khi **mọi lần thử** đều lỗi trước khi gửi được request (`ECONNREFUSED`, `ENOTFOUND`); có bất kỳ lần nào timeout, mất kết nối giữa chừng hoặc đích trả `5xx` thì `'UNKNOWN'`, dù lần cuối là `ECONNREFUSED` (C14, chốt 2026-11-16; làm rõ v1.2) |

## 4. Decorator

| Decorator | Tác dụng |
|---|---|
| `@Public()` | Bỏ `JwtAuthGuard` |
| `@Roles('ADMIN', ...)` | Cần một trong các vai trò; chuỗi tự do |
| `@CurrentUser('sub')` | Lấy trường từ JWT |
| `@Idempotent()` | Bật chống xử lý trùng theo `Idempotency-Key` (cần Redis) |
| `@RawResponse()` | Không bọc envelope |
| `@ApiEnvelope(Dto, opts?)` | Swagger cho response có envelope |

## 5. Biến môi trường

| Biến | Mặc định | Ý nghĩa |
|---|---|---|
| `SERVICE_NAME` | **bắt buộc** | Tên service trong log, `/health`, Swagger |
| `NODE_ENV` | `development` | |
| `PORT` | `3000` | |
| `LOG_LEVEL`, `LOG_PRETTY` | `info`, `false` | |
| `HTTP_TIMEOUT_MS` | `3000` | Chốt A2 (2026-11-12); `.env` gốc sửa về `3000` |
| `HTTP_MAX_RETRIES` | `2` | |
| `SWAGGER_ENABLED` | `true` (ảnh Docker `false`) | |
| `IDEMPOTENCY_TTL_SECONDS` | `86400` | |
| `DATABASE_URL` | tắt | Bật TypeORM + health `db` |
| `REDIS_URL` | tắt | Bật Redis + health `redis` |
| `RABBITMQ_*`, `OUTBOX_*` | | Xem `RE.MESSAGING/API_Spec.md §5` |
| `S3_ENDPOINT`, `S3_PUBLIC_ENDPOINT`, `S3_ACCESS_KEY`, `S3_SECRET_KEY`, `S3_BUCKETS`, `S3_REGION`, `S3_FORCE_PATH_STYLE`, `S3_PRESIGN_TTL_SECONDS` | tắt / `us-east-1` / `true` / `900` | Bật `StorageModule` + health `s3`. Bucket trong `S3_BUCKETS` phải có sẵn (v2.2). Cloudflare R2 (ADR-0016): `S3_ENDPOINT=https://<ACCOUNT_ID>.r2.cloudflarestorage.com`, `S3_REGION=auto`; `S3_PUBLIC_ENDPOINT` chỉ đặt khi host ký URL khác host service gọi |
| `JWT_PUBLIC_KEY`, `JWT_PUBLIC_KEY_PATH`, `JWT_SECRET`, `JWT_ISSUER` | tắt | Thứ tự ưu tiên: PEM → file → HS256 (chỉ dev) |

## 6. Đã chốt 2026-11-16

1. `HTTP_TIMEOUT_MS = 3000` (A2).
2. `InternalHttpService` gắn `details.outcome` (§3). A sửa template ở bước 0 của T1.2, kèm test trong `test/http-client.e2e-spec.ts`.
