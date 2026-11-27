# RE.SERVICE_TEMPLATE — Nhật ký thay đổi thiết kế

> Tạo ở lần sửa đầu tiên sau baseline v1.0 (`standards/design-standards.md §9`). Mục mới lên đầu, không sửa mục cũ.

## [v2.2] — 2026-11-26

- **type:** MINOR
- **author:** Claude (T1.4, A duyệt kế hoạch 2026-11-26)
- **summary:** `StorageService` bỏ bước tự tạo bucket lúc khởi động; bucket tạo sẵn trên Cloudflare R2 (ADR-0016, C26).

### Thay đổi

**1.** Bỏ tạo bucket lúc khởi động.

| # | Vị trí | Loại |
|---|---|---|
| 1 | `Component_Class_Design.md` §1 (cây thư mục), §4 (đoạn `StorageService`), §5 (bảng test); `Processing_Flow.md` §4 bước 3; `API_Spec.md` §5 (bảng biến) | Sửa |

- **Cũ:** `StorageModule` gọi `CreateBucket` cho mọi bucket trong `S3_BUCKETS` lúc khởi động (chạy nền, thử lại 10 lần, `BucketAlreadyOwnedByYou` coi là thành công), theo ADR-0007. `storage.infra-spec.ts` tạo bucket ngẫu nhiên rồi xóa; cần S3 chạy local (`localhost:9000`).
- **Mới:** service không gửi lệnh S3 nào lúc khởi động; bucket tạo tay trên dashboard. `S3_BUCKETS` chỉ cho health check và kiểm biến. `storage.infra-spec.ts` dùng bucket có sẵn `S3_TEST_BUCKET` (R2: `infra-test`), chỉ xóa key của lượt chạy; `.env` gốc thiếu cấu hình S3 thì bỏ qua cả file. Bảng biến ghi cấu hình R2.
- **Lý do:** ADR-0016 bỏ Silo, dùng R2 cho dev và production. Token R2 *Object Read & Write* không có quyền `CreateBucket` (`AccessDenied`, đo 2026-11-26): giữ bước này thì mỗi lần khởi động có 10 dòng log warn/error giả. A chốt xóa hẳn thay vì thêm biến tắt (C26). MINOR vì không đổi API, mã lỗi hay hợp đồng; chỉ đổi điều kiện vận hành (bucket phải có sẵn).

### File design đã sửa

- `Component_Class_Design.md` §1, §4, §5
- `Processing_Flow.md` §4
- `API_Spec.md` §5
- Header 3 file: v2.1 → v2.2

### Ảnh hưởng

- `services/_template-nest/src/storage/storage.service.ts`: xóa `ensureBucket`, `ensureBucketsWithRetry`, `bucketsReady`, `onApplicationBootstrap`.
- `services/_template-nest/test/helpers/infra.ts`: thêm `s3TestEnv`; `test/storage.infra-spec.ts` viết lại.
- Chép sang api-gateway, identity, listing, payment, rental (gateway chép lại nguyên bản template, có thêm `headObject`, không dùng S3 khi chạy).
- `infra/compose/docker-compose.yml`: bỏ service `s3`.
- `contracts/`: không đổi.

## [v2.1] — 2026-11-19

- **type:** MINOR
- **author:** hoang.lv
- **summary:** Hiện thực `StorageService.headObject` (thiết kế đã khai tên, code chưa có) để service kiểm kích thước ảnh sau khi tải lên (T2.2).

### Thay đổi

**1.** Bổ sung chữ ký và hành vi `headObject`.

| # | Vị trí | Loại |
|---|---|---|
| 1 | `Component_Class_Design.md` §2 (sơ đồ lớp), §4, §5 | Sửa |

- **Cũ:** sơ đồ lớp có `+headObject(bucket, key)` không kiểu trả về; không mô tả hành vi; không có `deleteObject`; code `StorageService` chưa có hàm.
- **Mới:** `headObject(bucket, key)` trả `{ contentLength, contentType }` hoặc `null` khi không có object; lỗi khác ném lại. Sơ đồ ghi thêm `deleteObject` (code đã có từ trước). Thêm `storage.service.spec.ts` và ca `headObject` ở `storage.infra-spec.ts`.
- **Lý do:** `RE.LISTING` route 8 phải kiểm kích thước ảnh bằng `HeadObject` (Báo cáo v2 §3.6.3, `gotchas.md`); phần kỹ thuật chung nên sửa ở template trước rồi chép sang service (ADR-0014). MINOR vì thêm hàm, không đổi hành vi đã có.

### File design đã sửa

- `Component_Class_Design.md` (sơ đồ `StorageService`, đoạn `headObject`, bảng test)
- Header 3 file: v2.0 → v2.1 (`API_Spec.md`, `Processing_Flow.md` chỉ đổi số phiên bản)

### Ảnh hưởng

- `services/_template-nest/src/storage/storage.service.ts`: thêm `headObject`.
- `services/identity`: chép lại `storage.service.ts` cho giống hệt template (identity không dùng S3, không đổi hành vi).
- `services/listing` (T2.2): dùng ở `ListingImageService.confirm`.
- `contracts/`: không đổi.

## [v2.0] — 2026-11-19

- **type:** MAJOR
- **author:** hoang.lv
- **summary:** Mọi tham số đường dẫn kiểu UUID, công khai và nội bộ, dùng `createUuidParamPipe`; `id` sai trả `400 VALIDATION_FAILED` thay `400 BAD_REQUEST` (chốt C19).

### Thay đổi

**1.** Thống nhất mã lỗi khi `id` trong đường dẫn sai.

| # | Vị trí | Loại |
|---|---|---|
| 1 | `API_Spec.md` §2, `Component_Class_Design.md` §4, §5 | Sửa |

- **Cũ:** (v1.3) route công khai dùng `new ParseUUIDPipe()` trần → `400 BAD_REQUEST`; chỉ API nội bộ mới dùng `createUuidParamPipe` → `400 VALIDATION_FAILED`. Route nội bộ mẫu `GET /internal/examples/:id` của template cũng còn dùng pipe trần.
- **Mới:** mọi `@Param` kiểu UUID dùng `createUuidParamPipe('<tên>')`: `400 VALIDATION_FAILED`, message "<tên> phải là UUID", `details: [{ field, errors }]`. Không dùng `new ParseUUIDPipe()` trần trong `services/*/src` (luật ESLint `no-restricted-imports` ở `eslint.config.mjs` gốc chặn). `BAD_REQUEST` chỉ còn cho body không đọc được (JSON sai cú pháp) và `Idempotency-Key` sai dạng.
- **Lý do:** A chốt C19 phương án (b) 2026-11-19 (`implementation/van-de-can-quyet-dinh.md` mục D): một mã cho một lỗi, client không phải xử lý hai mã tùy route. MAJOR vì đổi mã lỗi của route đã có (`design-standards.md §9`).

### File design đã sửa

- `API_Spec.md` §2 (thêm dòng "Tham số đường dẫn không phải UUID")
- `Component_Class_Design.md` §4 (đoạn `createUuidParamPipe`), §5 (thêm `test/example.e2e-spec.ts`)
- Header 3 file: v1.3 → v2.0 (`Processing_Flow.md` chỉ đổi số phiên bản)

### Ảnh hưởng

- `services/_template-nest`: `example.controller.ts`, `example-internal.controller.ts` đổi sang `createUuidParamPipe`; `test/example.e2e-spec.ts` kỳ vọng `VALIDATION_FAILED`.
- `services/identity`: không có route dùng pipe trần; chép lại chú thích `uuid-param.pipe.ts`.
- `api-gateway`: không kiểm `id`, không đổi.
- `contracts/openapi/*-internal.v1.yaml`: không đổi (đã khai `VALIDATION_FAILED`).
- listing, rental, payment, notification: nhận khi tạo từ template; luật ESLint chặn dùng pipe trần.
- `standards/api-convention.md` §3, §6 cập nhật cùng lúc.

## [v1.3] — 2026-11-18

- **type:** MINOR
- **author:** hoang.lv
- **summary:** Thêm `PageQueryDto` (query phân trang), `createUuidParamPipe` (lỗi UUID đúng hợp đồng nội bộ) và `expectResponseMatchesOpenApi` (test response khớp OpenAPI).

### Thay đổi

**1.**

| # | Vị trí | Loại |
|---|---|---|
| 1 | `Component_Class_Design.md` §1, §4, §5 | Thêm |

- **Cũ:** template có `Paginated` (khung response) nhưng không có DTO đọc `page`, `pageSize` từ query; mỗi service sẽ tự viết một bản.
- **Mới:** `src/common/response/page-query.dto.ts` + `.spec.ts`: `page` ≥ 1 (mặc định 1), `pageSize` 1–50 (mặc định 20), `@Type(() => Number)`, getter `skip`.
- **Lý do:** listing, rental, payment, notification, identity đều có API danh sách; ngưỡng 20/50 ở `non-functional-standards.md §1` cần một nơi duy nhất (ADR-0014). Phát hiện khi `reuse-scan` của T2.1.

**2.** Thêm `createUuidParamPipe`.

| # | Vị trí | Loại |
|---|---|---|
| 2 | `Component_Class_Design.md` §1, §4, §5 | Thêm |

- **Cũ:** `new ParseUUIDPipe()` trần trả `400 BAD_REQUEST`; bốn `contracts/openapi/*-internal.v1.yaml` đều khai `400 VALIDATION_FAILED`, message "<tên> phải là UUID".
- **Mới:** `src/common/errors/uuid-param.pipe.ts` + `.spec.ts`. Route công khai đang dùng `ParseUUIDPipe` (có test `BAD_REQUEST`) giữ nguyên; chỉ API nội bộ mới dùng pipe mới.
- **Lý do:** phát hiện khi viết test Bước 5 T2.1; listing, rental, payment cũng cần (ADR-0014).

**3.** Thêm `expectResponseMatchesOpenApi`.

| # | Vị trí | Loại |
|---|---|---|
| 3 | `Component_Class_Design.md` §1, §4, §5 | Thêm |

- **Cũ:** test chỉ kiểm được sự kiện khớp contract (`expectEventMatchesContract`); response API nội bộ không được kiểm với `contracts/openapi/`.
- **Mới:** `test/helpers/contracts.ts` thêm `expectResponseMatchesOpenApi(spec, method, path, status, body)` + `test/contracts-helper.e2e-spec.ts`; thêm devDependency `yaml@2.9.1` (cùng bản với gốc).
- **Lý do:** DoD T2.1 "response thật khớp `identity-internal.v1.yaml`"; mọi service có API nội bộ cần (ADR-0012).

### File design đã sửa

- `Component_Class_Design.md` §1, §4, §5
- Header 3 file: v1.2 → v1.3 (`API_Spec.md`, `Processing_Flow.md` chỉ đổi số phiên bản, không đổi nội dung)

### Ảnh hưởng

- `services/_template-nest` (A, T2.1): thêm `src/common/response/page-query.dto.ts`, `src/common/errors/uuid-param.pipe.ts`, `test/helpers/contracts.ts`, devDependency `yaml`; đã chép sang identity. api-gateway không cần. listing, rental, payment, notification nhận khi tạo từ template.

## [v1.2] — 2026-11-16

- **type:** MINOR
- **author:** hoang.lv
- **summary:** Tách `JwtTokenVerifier` khỏi `JwtAuthGuard` để gateway dùng chung.

### Thay đổi

**1.**

| # | Vị trí | Loại |
|---|---|---|
| 1 | `Component_Class_Design.md` §1, §2, §4, §5 | Sửa |

- **Cũ:** việc kiểm token là hàm `private` bên trong `JwtAuthGuard`.
- **Mới:** provider `JwtTokenVerifier` trong `common/auth/`, `JwtAuthGuard` gọi lại; hành vi và mã lỗi không đổi.
- **Lý do:** `AccessGuard` của api-gateway cần kiểm token theo mức truy cập từng route; viết bản riêng sẽ là bản song song của phần đã có trong template (ADR-0014).

**2.** Làm rõ `details.outcome` qua nhiều lần thử.

| # | Vị trí | Loại |
|---|---|---|
| 2 | `API_Spec.md` §3 | Sửa |

- **Cũ:** "`NOT_EXECUTED` chỉ khi chưa gửi được request, còn lại `UNKNOWN`" (không nói rõ khi có nhiều lần thử; code đã tính theo lần thử cuối).
- **Mới:** `NOT_EXECUTED` chỉ khi mọi lần thử đều lỗi trước khi gửi; có bất kỳ lần nào timeout, mất kết nối giữa chừng hoặc đích trả `5xx` thì `UNKNOWN`.
- **Lý do:** khớp `reliability-standard.md §2` ("chỉ cần một lần `unknown` thì kết quả là `unknown`"). Ca sai khi tính theo lần cuối: lần 1 timeout (đích có thể đã chạy), lần 2 `ECONNREFUSED` → báo `NOT_EXECUTED`, saga sẽ bù trừ nhầm đơn đã tạo ở đích.

### File design đã sửa

- `API_Spec.md` §3
- `Component_Class_Design.md` §1, §2, §4, §5
- Header 3 file: v1.1 → v1.2 (`Processing_Flow.md` chỉ đổi số phiên bản, không đổi nội dung)

### Ảnh hưởng

- `services/_template-nest` (A, bước 0 T1.2), chép sang identity và `api-gateway`.

## [v1.1] — 2026-11-16

- **type:** MINOR
- **author:** hoang.lv (A chốt cùng nhóm; người phụ trách code xem lại khi nhận task)
- **summary:** Thêm details.outcome cho InternalHttpService, ghi hành vi idempotency đã kiểm.

### Thay đổi

**1.**

| # | Vị trí | Loại |
|---|---|---|
| 1 | `API_Spec.md` §3, §5, §6 | Sửa |
| 2 | `Processing_Flow.md` §3, §5 | Sửa |

- **Cũ:** các điểm `[cần xác nhận]` ở những mục trên.
- **Mới:** giá trị đã chốt, tóm ở mục "Đã chốt 2026-11-16" cuối `API_Spec.md`.
- **Lý do:** chốt trước khi code; ghi ở `implementation/van-de-can-quyet-dinh.md` mục D ngày 2026-11-16.

### File design đã sửa

- `API_Spec.md` §3, §5, §6
- `Processing_Flow.md` §3, §5
- Header 3 file: v1.0 → v1.1

### Ảnh hưởng

- `services/_template-nest` (A, bước 0 T1.2), chép sang identity và các service mới; `.env` gốc `HTTP_TIMEOUT_MS=3000`.
