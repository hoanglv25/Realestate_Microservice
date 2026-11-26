# RE.GATEWAY — Nhật ký thay đổi thiết kế

> Tạo ở lần sửa đầu tiên sau baseline v1.0 (`standards/design-standards.md §9`). Mục mới lên đầu, không sửa mục cũ.

## [v1.4] — 2026-11-26

- **type:** MINOR
- **author:** Claude (đề xuất), chờ A duyệt (`implementation/van-de-can-quyet-dinh.md` C25)
- **summary:** Thêm định tuyến `public` cho danh mục địa giới của listing (`RE.LOCATION`).

### Thay đổi

**1.**

| # | Vị trí | Loại |
|---|---|---|
| 1 | `API_Spec.md` §3 (dòng 6a) | Thêm |

- **Cũ:** không có dòng cho `/api/v1/cities`, `/api/v1/districts`; gateway trả `404 GATEWAY_ROUTE_NOT_FOUND`.
- **Mới:** `GET /api/v1/cities`, `GET /api/v1/districts` → listing, mức `public`. Đặt `6a` để không đổi số các dòng đang được trỏ tới.
- **Lý do:** form tạo tin và bộ lọc tìm kiếm cần danh mục, kể cả khi chưa đăng nhập.

### File design đã sửa

- Header 3 file: v1.3 → v1.4.

### Ảnh hưởng

- Code: thêm hai dòng vào `services/api-gateway/src/gateway/routes.ts` và test `route-resolver.spec.ts` (task T2.6).

## [v1.3] — 2026-11-16

- **type:** MINOR
- **author:** hoang.lv
- **summary:** Làm rõ cách khớp bảng định tuyến (không phân biệt hoa thường, đường dẫn lạ không khớp), thêm ngoại lệ `GET /api/v1/listings/mine` mức `landlord`, catch-all dưới `/api/v1`, `upgrade` chỉ `/ws`.

### Thay đổi

**1.**

| # | Vị trí | Loại |
|---|---|---|
| 1 | `API_Spec.md` §3 (sau bảng) | Thêm |

- **Cũ:** bảng không nói thứ tự khớp, ý nghĩa của `:tên` và `/*`; `GET /api/v1/listings/mine` (mức `landlord`, `RE.LISTING/API_Spec.md §1` route 6) khớp dòng 4 `GET /api/v1/listings/:id` nên gateway coi là `public`.
- **Mới:** quy tắc khớp (dòng đầu thắng, `:tên` một đoạn, `/*` khớp tiền tố và mọi đường dẫn dưới nó theo ranh giới đoạn); ngoại lệ `GET /api/v1/listings/mine` → `landlord` đứng trước dòng 4. Đối chiếu với mọi route công khai trong `API_Spec.md` của các service: chỉ `mine` bị khớp sai.
- **Lý do:** gateway chặn thô theo vai trò; để `mine` thành `public` thì không kiểm token và rate limit theo IP thay vì theo `sub`. Service vẫn kiểm lại (`JwtAuthGuard`, `@Roles`), nên không lộ dữ liệu, nhưng sai tầng phòng thủ đầu tiên.

**2.** Catch-all dưới prefix `/api/v1`, thêm `RouteNotFoundFilter`.

| # | Vị trí | Loại |
|---|---|---|
| 2 | `Component_Class_Design.md` §1, §3.2 | Sửa |

- **Cũ:** §3.2 viết "Route này không gắn prefix `/api/v1`".
- **Mới:** catch-all `@All('{*path}')` nằm dưới prefix `/api/v1`; thêm `route-not-found.filter.ts` đổi `NotFoundException` của Nest (đường dẫn ngoài `/api/v1`) thành `404 GATEWAY_ROUTE_NOT_FOUND`.
- **Lý do:** `setGlobalPrefix` chỉ loại trừ theo mẫu đường dẫn; loại `{*path}` sẽ gỡ prefix của mọi controller (kể cả `HealthController` và controller test kế thừa từ template). Hành vi nhìn từ ngoài không đổi: mọi đường dẫn không khớp bảng đều là `GATEWAY_ROUTE_NOT_FOUND`.

**3.** Khớp không phân biệt hoa thường, đường dẫn lạ, upgrade `/ws`, lỗi proxy.

| # | Vị trí | Loại |
|---|---|---|
| 3 | `API_Spec.md` §3 "Cách khớp" | Thêm |
| 4 | `Component_Class_Design.md` §3.2 | Thêm |

- **Cũ:** "Cách khớp" không nói hoa/thường, đường dẫn mã hóa; §3.2 không nói `upgrade` nhận đường dẫn nào, và không nói lỗi proxy dùng `on.error` riêng.
- **Mới:** (a) khớp **không phân biệt hoa thường** ở phần chữ cố định, chỉ để so, không đổi đường dẫn chuyển tiếp; (b) đường dẫn lạ (đoạn rỗng, `.`, `..`, `%2e`/`%2f`/`%5c`, `\`) không bao giờ khớp → `404 GATEWAY_ROUTE_NOT_FOUND`, không giải mã; (c) `HEAD` khớp như `GET`; (d) `upgrade` chỉ nhận `/ws`, đường dẫn khác bị `404` rồi đóng socket; (e) lỗi proxy luôn dùng `on.error` riêng (không lộ `host`/URL), 504 do gateway tự cắt thời gian chờ.
- **Lý do:** (a) `GET /api/v1/listings/MINE` bị khớp `:id` (`public`) nhưng listing vẫn route tới handler `mine`, cùng loại lỗi `mine` ở mục 1; (b) không ai né mức truy cập bằng cách viết lại đường dẫn; (d) `upgrade` không qua `AccessGuard` nên không được phép tới route khác; (e) plugin mặc định của `http-proxy-middleware` ghi `host` và URL vào body lỗi.

### File design đã sửa

- `API_Spec.md` §3
- `Component_Class_Design.md` §1, §3.2
- Header 3 file: v1.2 → v1.3

### Ảnh hưởng

- api-gateway (A, T1.2): `routes.ts`, `RouteResolver`. Không đổi API công khai, mã lỗi, `contracts/`.

## [v1.2] — 2026-11-16

- **type:** MINOR
- **author:** hoang.lv
- **summary:** Proxy chạy sau guard qua `GatewayController` catch-all; rate limit đặt sau `AccessGuard`, đếm theo `sub` hoặc IP; giữ nguyên thư mục tùy chọn của template.

### Thay đổi

**1.** Proxy không còn là middleware `app.use`.

| # | Vị trí | Loại |
|---|---|---|
| 1 | `Component_Class_Design.md` §1, §2, §3 | Sửa |

- **Cũ:** §3 xếp `Throttler → RouteResolver → AccessGuard → ProxyMiddleware` như một chuỗi middleware.
- **Mới:** §3.1 middleware `app.use` (correlation, access log, `InternalBlock`, CORS); §3.2 `GatewayController` catch-all (`@Public`, `@RawResponse`, `@Req/@Res`) chạy `AccessGuard`, `GatewayThrottlerGuard` rồi gọi `ProxyMiddleware`. Lỗi guard đi qua `AllExceptionsFilter`; lỗi proxy dựng `{ error, meta }` trong `on.error`. `/ws` đi qua `server.on('upgrade')`.
- **Lý do:** middleware Express chạy trước guard Nest nên không thể đứng sau `AccessGuard`. Hành vi nhìn từ ngoài (mã lỗi, thứ tự 401/403/404) không đổi.

**2.** Cách đếm rate limit.

| # | Vị trí | Loại |
|---|---|---|
| 2 | `Component_Class_Design.md` §1, §3.2, §4 (test 10) | Sửa |
| 3 | `API_Spec.md` §1, §5, §6 | Sửa |
| 4 | `Processing_Flow.md` §1 | Sửa |

- **Cũ:** throttler trước route resolver, 100 request/IP và 300 request/`sub` áp đồng thời.
- **Mới:** một throttler sau `AccessGuard`: có người dùng thì tracker `sub`, giới hạn `RATE_LIMIT_USER` (300); không có (`public`, `payos`) thì tracker IP, giới hạn `RATE_LIMIT_IP` (100). Test 10 kiểm cả hai nhánh.
- **Lý do:** SSR Next.js và NAT gom nhiều người về một IP; đếm IP cho mọi request làm giới hạn theo `sub` vô nghĩa. Giá trị mặc định không đổi.
- **Đã chốt:** `trust proxy = false` cho IP của request không có người dùng: không tin `X-Forwarded-For`, không thêm biến môi trường (`Component_Class_Design.md §6`). Hệ quả chấp nhận: qua đường hầm hoặc bridge Docker, request ẩn danh dùng chung một bộ đếm IP.

**3.** Thư mục tùy chọn của template.

| # | Vị trí | Loại |
|---|---|---|
| 5 | `Component_Class_Design.md` §1 | Sửa |

- **Cũ:** "Copy từ `_template-nest`, không bật `DATABASE_URL`, `RABBITMQ_URL`, `S3_ENDPOINT`".
- **Mới:** giữ nguyên `database/`, `messaging/`, `redis/`, `storage/` và test của chúng, không đặt env (thêm `REDIS_URL`).
- **Lý do:** ADR-0014, không sửa riêng bản chép.

### File design đã sửa

- `Component_Class_Design.md` §1, §2, §3, §4, §5, §6
- `API_Spec.md` §1, §5, §6
- `Processing_Flow.md` §1
- Header 3 file: v1.1 → v1.2

### Ảnh hưởng

- api-gateway (A, T1.2). Cần `JwtTokenVerifier` trong template (`RE.SERVICE_TEMPLATE` v1.2).
- Không đổi API công khai, mã lỗi, `contracts/`.

## [v1.1] — 2026-11-16

- **type:** MINOR
- **author:** hoang.lv (A chốt cùng nhóm; người phụ trách code xem lại khi nhận task)
- **summary:** Chốt CORS_ORIGINS.

### Thay đổi

**1.**

| # | Vị trí | Loại |
|---|---|---|
| 1 | `API_Spec.md` §5, §6 | Sửa |

- **Cũ:** các điểm `[cần xác nhận]` ở những mục trên.
- **Mới:** giá trị đã chốt, tóm ở mục "Đã chốt 2026-11-16" cuối `API_Spec.md`.
- **Lý do:** chốt trước khi code; ghi ở `implementation/van-de-can-quyet-dinh.md` mục D ngày 2026-11-16.

### File design đã sửa

- `API_Spec.md` §5, §6
- Header 3 file: v1.0 → v1.1

### Ảnh hưởng

- api-gateway (A, T1.2).
