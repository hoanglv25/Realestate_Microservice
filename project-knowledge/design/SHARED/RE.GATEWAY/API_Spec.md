# RE.GATEWAY — Đặc tả API

| | |
|---|---|
| **Mã chức năng** | `RE.GATEWAY` — điểm vào duy nhất |
| **Service** | `api-gateway` (cổng 8080), dựng từ `_template-nest` |
| **Quy tắc** | NFR03, NFR06; không chứa `BR-xx` |
| **Quyết định** | ADR-0003 |
| **CSDL** | Không. Bộ đếm rate limit trong bộ nhớ của gateway (một instance; chốt 2026-11-16) |
| **Chủ sở hữu / Cập nhật / Phiên bản** | hoang.lv — 2026-11-26 — v1.4 (đề xuất, chờ A duyệt: C25) |

## 1. Việc gateway làm và không làm

| Làm | Không làm |
|---|---|
| Định tuyến theo bảng §3 (một file cấu hình) | Kiểm chủ sở hữu tài nguyên |
| Kiểm JWT RS256 (chữ ký, hạn, `iss`) bằng khóa công khai | Gọi identity để xác thực |
| Kiểm vai trò mức tuyến | Gộp dữ liệu nhiều service |
| Sinh `X-Request-ID` nếu thiếu, chuyển tiếp | Retry (không biết lệnh có idempotent không) |
| CORS cho giao diện Next.js | Đọc database |
| Rate limit: theo `sub` cho người đã xác thực, theo IP cho request không có người dùng (§5) | Luật nghiệp vụ |
| `404` cho mọi `/internal/*` | |
| Mở công khai đường dẫn webhook payOS | Kiểm chữ ký webhook (payment làm) |

## 2. Mức truy cập

| Mức | Điều kiện |
|---|---|
| `public` | Không cần token |
| `user` | Token hợp lệ, vai trò bất kỳ |
| `tenant` | `TENANT` |
| `landlord` | `LANDLORD` |
| `admin` | `ADMIN` |
| `payos` | Không cần token; payment kiểm chữ ký |

Gateway chỉ kiểm thô. Service kiểm lại vai trò và chủ sở hữu.

## 3. Bảng định tuyến

Đường dẫn chốt 2026-11-12 (A6), chi tiết ở `API_Spec.md` của chức năng.

| # | Tiền tố | Service đích | Mức mặc định | Thiết kế |
|---|---|---|---|---|
| 1 | `/api/v1/auth/*` | identity | `public` (`/me`: `user`); gồm OTP, quên mật khẩu, Google | `RE.IDENTITY` |
| 2 | `/api/v1/users/me`, `/api/v1/users/me/*` | identity | `user` | `RE.IDENTITY` |
| 3 | `/api/v1/admin/users/*` | identity | `admin` | `RE.IDENTITY` |
| 4 | `GET /api/v1/listings`, `GET /api/v1/listings/:id` | listing | `public` | `RE.LISTING` |
| 5 | `/api/v1/listings/*` (còn lại) | listing | `landlord` | `RE.LISTING` |
| 6 | `/api/v1/admin/listings/*` | listing | `admin` | `RE.LISTING` |
| 6a | `GET /api/v1/cities`, `GET /api/v1/districts` (v1.4) | listing | `public` | `RE.LOCATION` |
| 7 | `/api/v1/viewings/*` | rental | `user` | `RE.VIEWING` |
| 8 | `/api/v1/deposits/*` | rental | `user` | `RE.DEPOSIT_SAGA`, `RE.DEPOSIT_LIFECYCLE` |
| 9 | `/api/v1/admin/deposits/*` | rental | `admin` | `RE.DEPOSIT_LIFECYCLE` |
| 10 | `POST /api/v1/payments/payos/webhook` | payment | `payos` | `RE.PAYMENT` |
| 11 | `/api/v1/payments/*` (còn lại) | payment | `user` | `RE.PAYOUT` |
| 12 | `/api/v1/withdrawals/*` | payment | `landlord` | `RE.PAYOUT` |
| 13 | `/api/v1/admin/withdrawals/*`, `/api/v1/admin/refund-requests/*`, `/api/v1/admin/wallet`, `/api/v1/admin/audit-logs` | payment | `admin` | `RE.PAYOUT` |
| 14 | `/api/v1/notifications/*` | notification | `user` | `RE.NOTIFICATION` |
| 15 | `/api/v1/conversations/*` | notification | `user` | `RE.CHAT` |
| 16 | WebSocket `/ws` | notification | `user` — gateway chỉ chuyển tiếp upgrade, notification kiểm access token trong handshake | `RE.CHAT` |
| 17 | `/internal/*` | — | trả `404` | |
| 18 | `GET /health` | chính gateway | `public` | |

Mức chi tiết từng route (ví dụ route chỉ `tenant` trong `/api/v1/deposits/*`) do service kiểm bằng `@Roles`.

**Cách khớp (v1.3):**

- Duyệt bảng theo thứ tự từ trên xuống, dòng đầu khớp thắng; dòng cụ thể (có method, hoặc đường dẫn đầy đủ) đứng trước dòng chung.
- `:tên` khớp đúng một đoạn đường dẫn. `/*` ở cuối khớp chính tiền tố đó và mọi đường dẫn dưới nó, theo ranh giới đoạn (`/api/v1/auth/*` khớp `/api/v1/auth` và `/api/v1/auth/login`, không khớp `/api/v1/authx`).
- Dòng không ghi method khớp mọi method; `HEAD` khớp như `GET`.
- **Không phân biệt hoa thường** ở phần chữ cố định của đường dẫn (và method), như Express của gateway và của service đích: `GET /api/v1/listings/MINE` vẫn tới handler `mine` của listing nên phải khớp dòng `mine` (`landlord`), không phải `:id` (`public`); `/API/V1/ADMIN/users/x` khớp `admin`. Gateway chỉ hạ chữ thường để so, **không đổi** đường dẫn chuyển tiếp. Đoạn `:tên` giữ nguyên giá trị.
- **Đường dẫn lạ không bao giờ khớp** (fail-closed, `404 GATEWAY_ROUTE_NOT_FOUND`): đoạn rỗng (`//`), đoạn `.` hoặc `..`, mã hóa `%2e`, `%2f`, `%5c` (không phân biệt hoa thường), ký tự `\`. Gateway không giải mã rồi chuẩn hóa đường dẫn, để không lệch với cách service đích hiểu và không ai né được mức truy cập bằng cách viết lại đường dẫn. Query string và một dấu `/` cuối được bỏ khi khớp.
- Hai ngoại lệ của dòng chung, đứng trước nó: `GET /api/v1/auth/me` mức `user` (dòng 1); `GET /api/v1/listings/mine` mức `landlord` (dòng 5). Nếu không có ngoại lệ thứ hai, `mine` khớp `GET /api/v1/listings/:id` (dòng 4) thành `public`.
- Không khớp dòng nào → `404 GATEWAY_ROUTE_NOT_FOUND`. `/internal/*` bị chặn trước đó (dòng 17); `GET /health` do chính gateway trả (dòng 18), không đi qua bảng.

## 4. Mã lỗi của gateway

| Mã | HTTP | Khi nào | Nguồn |
|---|---|---|---|
| `AUTH_TOKEN_MISSING` | 401 | Route cần token mà thiếu | Code (template) |
| `AUTH_TOKEN_INVALID` | 401 | Sai chữ ký, sai `iss` | Code |
| `AUTH_TOKEN_EXPIRED` | 401 | Hết hạn | Code |
| `FORBIDDEN_ROLE` | 403 | Sai vai trò mức tuyến | Code |
| `GATEWAY_ROUTE_NOT_FOUND` | 404 | Không khớp bảng §3, gồm `/internal/*` | Đề xuất |
| `TOO_MANY_REQUESTS` | 429 | Vượt rate limit | Code |
| `UPSTREAM_UNAVAILABLE` | 503 | Service đích không kết nối được | Code |
| `UPSTREAM_TIMEOUT` | 504 | Service đích quá `GATEWAY_PROXY_TIMEOUT_MS` | Code |

Lỗi `4xx`/`5xx` của service đích chuyển nguyên về client.

## 5. Biến môi trường

| Biến | Mặc định dev | Ý nghĩa |
|---|---|---|
| `PORT` | `8080` | |
| `SERVICE_NAME` | `api-gateway` | |
| `JWT_PUBLIC_KEY_PATH`, `JWT_ISSUER` | `./secrets/jwt-public.pem`, `realestate-identity` | |
| `INTERNAL_IDENTITY_URL` … `INTERNAL_NOTIFICATION_URL` | `http://<service>:<cổng>` | Đích proxy |
| `GATEWAY_PROXY_TIMEOUT_MS` | `10000` | Phải > 8.000 (NFR07, ngân sách đặt cọc) |
| `RATE_LIMIT_TTL_SECONDS`, `RATE_LIMIT_IP`, `RATE_LIMIT_USER` | `60`, `100`, `300` | Cửa sổ 60 giây. Request có người dùng đã xác thực đếm theo `sub`, tối đa 300; request không có người dùng (`public`, `payos`) đếm theo IP, tối đa 100. Không đếm IP của request đã đăng nhập (SSR Next.js, NAT gom nhiều người về một IP). Bộ đếm trong bộ nhớ |
| `CORS_ORIGINS` | `http://localhost:3000` | Danh sách cách nhau dấu phẩy; giao diện Next.js |

## 6. Đã chốt 2026-11-16 (C7)

1. Proxy bằng `http-proxy-middleware`. Gateway tắt body parser (`NestFactory.create(..., { bodyParser: false })`) nên body đi nguyên vẹn tới service đích, kể cả webhook payOS (chữ ký tính trên body).
2. Timeout proxy `10000` ms; rate limit `@nestjs/throttler`, bộ đếm trong bộ nhớ, ngưỡng ở §5. Cách đếm (v1.2): một throttler sau `AccessGuard`, có người dùng thì theo `sub`, không thì theo IP (`Component_Class_Design.md §3.2`).
3. WebSocket: `ws: true` cho route `/ws`, gateway chỉ chuyển tiếp upgrade; xác thực access token trong handshake do notification làm (`RE.CHAT/API_Spec.md §3`).
4. Không làm `/health/services`; mỗi service tự có `/health`.
5. `CORS_ORIGINS` mặc định `http://localhost:3000`, nhiều địa chỉ cách nhau dấu phẩy.
