# RE.IDENTITY — Đặc tả API

| | |
|---|---|
| **Mã chức năng** | `RE.IDENTITY` — tài khoản, xác minh email OTP, quên mật khẩu, đăng nhập Google, phiên, khóa tài khoản, tài khoản nhận tiền, vai trò |
| **Service** | `identity` (cổng 3001) |
| **Quy tắc** | BR-01, BR-02; quy tắc phụ Bảng 2.6 |
| **CSDL** | `identity_db` / `identity_user`; Redis (refresh token, OTP, token đặt lại mật khẩu); SMTP (dev: Gmail App Password, v2.5) |
| **Chủ sở hữu / Cập nhật / Phiên bản** | hoang.lv — 2026-11-28 — v2.5 |

## 1. API công khai

| # | Method, đường dẫn | Quyền | Kết quả | Nguồn |
|---|---|---|---|---|
| 1 | `POST /api/v1/auth/register` | public | `201` user `PENDING_VERIFICATION`; chỉ `TENANT`/`LANDLORD`; gửi OTP | Code, sửa theo B10 |
| 2 | `POST /api/v1/auth/login` | public | `200` `{ accessToken, refreshToken, tokenType, expiresIn }`; chặn tài khoản chưa xác minh, bị khóa | Code, sửa theo B10, C2 |
| 3 | `POST /api/v1/auth/refresh` | public | `200` cặp token mới; token cũ dùng một lần | Code |
| 4 | `POST /api/v1/auth/logout` | public | `204`; thu hồi cả họ refresh token | Code |
| 5 | `GET /api/v1/auth/me` | user | `200` người đang đăng nhập | Code |
| 6 | `GET /api/v1/users/me/bank-account` | user | `200` `{ bankName, accountHolder, accountLast4, updatedAt }` hoặc `404 IDENTITY_BANK_ACCOUNT_NOT_FOUND` | Chốt 2026-11-13; §1.4 |
| 7 | `PUT /api/v1/users/me/bank-account` | user | `200` cùng dạng route 6; số tài khoản mã hóa khi lưu | Chốt 2026-11-13; §1.4 |
| 8 | `GET /api/v1/admin/users` | admin | `200` danh sách phân trang | Chốt 2026-11-13; §1.11 |
| 9 | ~~`PATCH /api/v1/admin/users/:id/role`~~ | — | **Bỏ** (2026-11-18): vai trò cố định từ lúc tạo tài khoản | Bỏ 2026-11-18 |
| 10 | `POST /api/v1/auth/verify-otp` | public | `200` cặp token; tài khoản `ACTIVE` | Chốt 2026-11-13 (B10) |
| 11 | `POST /api/v1/auth/resend-otp` | public | `202` luôn (không lộ email) | Chốt 2026-11-13 (B10) |
| 12 | `POST /api/v1/auth/forgot-password` | public | `202` luôn (Bảng 2.6: không lộ email có tồn tại) | Chốt 2026-11-13 (B10) |
| 13 | `POST /api/v1/auth/reset-password` | public | `204`; thu hồi mọi phiên | Chốt 2026-11-13 (B10) |
| 14 | `POST /api/v1/auth/google` | public | `200` cặp token | Chốt 2026-11-13 (B10) |
| 15 | `PATCH /api/v1/users/me` | user | `200`; sửa `fullName`, `phone` | Chốt 2026-11-13 (B9) |
| 16 | `POST /api/v1/admin/users/:id/lock`, `POST /api/v1/admin/users/:id/unlock` | admin | `200` | Chốt 2026-11-13 (C2) |

Mỗi tài khoản đúng một vai trò ở `users.role`, **cố định từ lúc tạo** (đăng ký, Google, `seed:admin`); không có API nào đổi vai trò, kể cả quản trị viên. Muốn vai trò khác thì đăng ký tài khoản mới bằng email khác (B9 2026-11-12; bỏ đổi vai trò 2026-11-18).

### 1.1 `POST /auth/register`

| Trường | Kiểu | Ràng buộc |
|---|---|---|
| `email` | string | email |
| `password` | string | theo `register.dto.ts` |
| `fullName` | string | ≤ 200 |
| `role` | string | `TENANT` hoặc `LANDLORD` |
| `phone` | string, không bắt buộc | Duy nhất khi có (B9); số di động Việt Nam `^0\d{9}$` (chốt 2026-11-16) |

Thứ tự kiểm tra:

| # | Điều kiện | Kết quả |
|---|---|---|
| 1 | DTO sai, hoặc `role` khác `TENANT`/`LANDLORD` (gồm `ADMIN`) | `400 VALIDATION_FAILED` (BR-01) |
| 2 | Vi phạm `UQ_users_email_lower` | `409 IDENTITY_EMAIL_TAKEN` (BR-02) |
| 3 | Vi phạm `UQ_users_phone` | `409 IDENTITY_PHONE_TAKEN` |
| 4 | Hợp lệ | `INSERT users` (`status = PENDING_VERIFICATION`) + outbox `identity.registered` cùng transaction; sau commit sinh OTP (Redis) và gửi email → `201` |

Redis dừng: `503 DEPENDENCY_UNAVAILABLE` trước khi ghi DB. Sau commit, sinh OTP và gửi email **không chờ** (chốt 2026-11-20, v2.3): `201` trả ngay, việc gửi chạy nền và lỗi (SMTP, Redis) chỉ ghi log `warn` (không kèm OTP, địa chỉ nhận, link); người dùng bấm gửi lại (route 11). Lý do: thời gian phản hồi không phụ thuộc SMTP và không lộ gì qua độ trễ. Hệ quả: nhận `201` chưa chắc đã có email (client hiện thông báo "kiểm tra hộp thư, chưa thấy thì gửi lại").

### 1.2 `POST /auth/login`

| # | Điều kiện | Kết quả |
|---|---|---|
| 1 | Sai email hoặc sai mật khẩu, hoặc tài khoản chỉ có Google (không có mật khẩu) | `401 IDENTITY_INVALID_CREDENTIALS` (không lộ email đã đăng ký) |
| 2 | `status = PENDING_VERIFICATION` | `403 IDENTITY_EMAIL_NOT_VERIFIED` |
| 3 | `status = LOCKED` | `403 IDENTITY_ACCOUNT_LOCKED` |
| 4 | Hợp lệ | `200` cặp token |

Kiểm trạng thái **sau** khi đúng mật khẩu, để người không biết mật khẩu không dò được trạng thái tài khoản. Redis dừng → `503 DEPENDENCY_UNAVAILABLE`.

### 1.3 `POST /auth/refresh`

Token không có, hết hạn, đã thu hồi, bị dùng lại → `401 IDENTITY_INVALID_REFRESH_TOKEN`. Token đã dùng bị gửi lại → thu hồi cả họ.

### 1.4 Tài khoản nhận tiền (route 6, 7)

Route 7 `PUT /users/me/bank-account`, body:

| Trường | Kiểu | Ràng buộc |
|---|---|---|
| `bankName` | string | Tự do, 2–100 ký tự (frontend gợi ý danh sách; chốt 2026-11-16) |
| `accountNumber` | string | Chỉ chữ số, 6–19 ký tự `^\d{6,19}$` |
| `accountHolder` | string | 1–200 ký tự sau khi cắt khoảng trắng hai đầu (chốt 2026-11-18) |

Một người một tài khoản nhận tiền: `PUT` ghi đè bản cũ (chốt 2026-11-16), bằng một câu `INSERT … ON CONFLICT (user_id) DO UPDATE … RETURNING`; luôn `200` (không phân biệt tạo mới hay ghi đè).

Response route 6 và 7 (trong `data`): `{ bankName, accountHolder, accountLast4, updatedAt }`. Không bao giờ có số đầy đủ. Route 6 khi người gọi chưa khai → `404 IDENTITY_BANK_ACCOUNT_NOT_FOUND`. Người gọi luôn là `sub` trong JWT, không nhận `userId` trong đường dẫn hay body.

**Mã hóa (chốt 2026-11-18).** `account_number_encrypted = iv (12 byte) ‖ authTag (16 byte) ‖ ciphertext`, AES-256-GCM, khóa `BANK_ACCOUNT_ENCRYPTION_KEY`. IV ngẫu nhiên mỗi lần ghi. **AAD = `userId`**: dòng của người này chép sang người khác thì giải mã lỗi. Khóa sai hoặc dữ liệu hỏng → giải mã lỗi → `500 INTERNAL_ERROR`, log `error` không kèm số tài khoản. Không có cơ chế xoay khóa: ghi vào mục Hạn chế của báo cáo.

**Khi nào khai (A chốt 2026-11-18).** Trang hồ sơ không có mục khai riêng. Giao diện hiện form khai khi người dùng **rút tiền lần đầu** (payment trả `409 PAYMENT_BANK_ACCOUNT_MISSING`) hoặc **gửi yêu cầu hoàn lần đầu** (giao diện gọi route 6, `404` thì hiện form); sau đó gọi route 7 rồi thử lại. API identity không đổi vì điều này.

### 1.5 ~~`PATCH /admin/users/:id/role`~~ — bỏ 2026-11-18

Không đổi vai trò của tài khoản đã có. Gọi đường dẫn này qua gateway khớp dòng `/api/v1/admin/users/*` nhưng identity không có route → `404` như mọi đường dẫn không tồn tại. Lý do và ảnh hưởng: `CHANGELOG.md` v2.0.

### 1.6 Xác minh email OTP (route 10, 11) — Bảng 2.6

OTP 6 chữ số, hiệu lực 5 phút, sai 5 lần thì hủy, gửi lại sau 60 giây (Báo cáo Bảng 2.6). Lưu Redis dạng băm, không lưu DB.

Route 10, body `{ email, otp }`:

| # | Điều kiện | Kết quả |
|---|---|---|
| 1 | DTO sai | `400 VALIDATION_FAILED` |
| 2 | Không có tài khoản `PENDING_VERIFICATION` với email, hoặc không có OTP còn hiệu lực | `400 IDENTITY_OTP_INVALID` |
| 3 | Sai mã: tăng số lần sai; lần thứ 5 xóa OTP | `400 IDENTITY_OTP_INVALID` |
| 4 | Đúng | Xóa OTP; `UPDATE users SET status='ACTIVE', email_verified_at=now() WHERE id AND status='PENDING_VERIFICATION'`; cấp phiên → `200` cặp token |

Route 11, body `{ email }`: còn trong 60 giây kể từ lần gửi trước → `429 IDENTITY_OTP_RESEND_TOO_SOON`; email không tồn tại hoặc đã xác minh → `202` không gửi; còn lại sinh OTP mới (thay mã cũ, đặt lại số lần sai) và gửi → `202`. Gửi email không chờ, lỗi chỉ ghi log `warn` (chốt 2026-11-20, v2.3). Cooldown hiện lưu theo `userId` nên `429` chỉ có với email có tài khoản: còn lộ email, đề xuất chuyển sang `lower(email)` ở `implementation/van-de-can-quyet-dinh.md` C21 (chưa sửa).

### 1.7 Quên mật khẩu (route 12, 13) — Bảng 2.6

Route 12, body `{ email }`: luôn `202`. Có tài khoản không bị khóa → sinh token ngẫu nhiên 32 byte, lưu Redis `sha256(token)` → `userId` TTL `PASSWORD_RESET_TTL_SECONDS`, gửi email link `PASSWORD_RESET_URL?token=<token>` (trang Next.js). Gửi email không chờ, lỗi chỉ ghi log `warn` (chốt 2026-11-20, v2.3), để độ trễ không cho biết email có tài khoản hay không.

Route 13, body `{ token, newPassword }`:

| # | Điều kiện | Kết quả |
|---|---|---|
| 1 | DTO sai, mật khẩu không đạt `register.dto.ts` | `400 VALIDATION_FAILED` |
| 2 | Token không có, hết hạn, đã dùng | `400 IDENTITY_RESET_TOKEN_INVALID` |
| 3 | Hợp lệ | Xóa token (dùng một lần); cập nhật `password_hash`; thu hồi mọi họ refresh token của người đó → `204` |

### 1.8 Đăng nhập Google (route 14)

Frontend lấy ID token bằng Google Sign-In rồi gọi route 14. Body `{ idToken, role? }`.

| # | Điều kiện | Kết quả |
|---|---|---|
| 0 | `GOOGLE_CLIENT_ID` không đặt (chốt 2026-11-20, v2.3) | `503 DEPENDENCY_UNAVAILABLE`, **trước** khi kiểm token; service vẫn khởi động, log `warn` một lần lúc khởi động |
| 1 | ID token sai chữ ký, sai `aud` (`GOOGLE_CLIENT_ID`), hết hạn | `401 IDENTITY_GOOGLE_TOKEN_INVALID` |
| 2 | Token không có email hoặc `email_verified = false` | `401 IDENTITY_GOOGLE_TOKEN_INVALID` (Bảng 2.6: bắt buộc có email) |
| 3 | Đã có `user_identities (google, sub)` | Lấy user đó |
| 4 | Chưa có liên kết nhưng email đã có tài khoản | Tự liên kết: `INSERT user_identities`; vai trò giữ nguyên. Tài khoản còn `PENDING_VERIFICATION` → `ACTIVE` và **xóa `password_hash`** (mật khẩu do người chưa chứng minh sở hữu email đặt; chủ email đặt lại qua route 12) |
| 4a | Chưa có liên kết theo `sub`, nhưng tài khoản của email đã liên kết với **một tài khoản Google khác** (`UQ_user_identities_user_provider`; ví dụ tài khoản Google bị xóa rồi tạo lại cùng email) | `401 IDENTITY_GOOGLE_TOKEN_INVALID`; không thêm liên kết, không đổi tài khoản. Phát hiện bằng ràng buộc của DB ở lần thử lại (lần đầu có thể là đua cùng `sub`) (chốt 2026-11-20, v2.4) |
| 5 | Chưa có tài khoản, thiếu `role` hoặc `role` khác `TENANT`/`LANDLORD` | `400 IDENTITY_ROLE_REQUIRED` (client hiện bước chọn vai trò rồi gọi lại) |
| 6 | Chưa có tài khoản, có `role` | Transaction: `INSERT users` (`password_hash = null`, `status = ACTIVE`, `email_verified_at = now()`) + `user_identities` + outbox `identity.registered` |
| 7 | `status = LOCKED` | `403 IDENTITY_ACCOUNT_LOCKED` |
| 8 | Hợp lệ | `200` cặp token |

Thư viện kiểm ID token: `google-auth-library` (`OAuth2Client.verifyIdToken`), chốt 2026-11-13, ghi ở `architecture.md §5`.

### 1.9 Khóa, mở khóa tài khoản (route 16) — C2, Bảng 2.6

Body route khóa `{ reason }` (bắt buộc). Chỉ thay đổi identity: tin đăng, đơn, tiền của người đó không bị động tới; quản trị viên dùng chức năng sẵn có nếu cần.

| # | Điều kiện | Kết quả |
|---|---|---|
| 1 | Người dùng không tồn tại | `404 IDENTITY_USER_NOT_FOUND` |
| 2 | Khóa chính mình | `409 IDENTITY_CANNOT_LOCK_SELF` |
| 3 | Khóa: `UPDATE users SET status='LOCKED', locked_at, locked_by, lock_reason WHERE id AND status <> 'LOCKED'`; 0 dòng → đã khóa, vẫn chạy bước 4 (idempotent) | |
| 4 | Thu hồi mọi họ refresh token của người đó; Redis lỗi | `503 DEPENDENCY_UNAVAILABLE`; trạng thái đã `LOCKED` nên đăng nhập mới bị chặn; quản trị viên gọi lại để thu hồi |
| 5 | Xong | `200`. Access token còn hạn tối đa 15 phút (Báo cáo §7.2) |

Mở khóa: về trạng thái trước khi khóa: `email_verified_at` có → `ACTIVE`, chưa có → `PENDING_VERIFICATION` (phải nhập OTP); xóa `locked_*` (chốt 2026-11-13).

### 1.10 `PATCH /users/me` (route 15)

Body `{ fullName?, phone? }`. `fullName` 1–200 ký tự sau khi cắt khoảng trắng; `phone` theo `^0\d{9}$`. `phone` trùng người khác → `409 IDENTITY_PHONE_TAKEN`; `phone: null` xóa số; trường vắng mặt thì giữ nguyên; `fullName: null` → `400 VALIDATION_FAILED` (chỉ `phone` nhận `null`, v2.4). Body không có trường nào → `400 VALIDATION_FAILED`. `200` trả `UserDto` (§1.12).

### 1.11 `GET /admin/users` (route 8)

Chỉ `ADMIN` (`@Roles('ADMIN')`; gateway cũng chặn thô `/api/v1/admin/*`). Query:

| Tham số | Kiểu | Ràng buộc |
|---|---|---|
| `page` | số nguyên | ≥ 1, mặc định 1 |
| `pageSize` | số nguyên | 1–50, mặc định 20; vượt → `400 VALIDATION_FAILED` |
| `role` | string, không bắt buộc | `TENANT`, `LANDLORD`, `ADMIN`; giá trị khác → `400` |

Sắp theo `created_at DESC, id DESC`. `data` là mảng `UserDto` (§1.12). `meta` có `page`, `pageSize`, `total`, `totalPages` (khung `Paginated` của template). Dùng `findAndCount`: **tối đa 2 truy vấn** (lấy trang + đếm; ngưỡng danh sách là 4, `non-functional-standards.md §1`). TypeORM bỏ truy vấn đếm khi trang đầu chưa đầy (`OFFSET 0`, ít dòng hơn `pageSize`) vì `total` chính là số dòng nhận được, nên trường hợp đó chỉ 1 truy vấn; `total` vẫn đúng. Chỉ chọn bảy cột của `UserDto`, không bao giờ đọc `password_hash`. Trang vượt quá: `data: []`, `total` và `totalPages` vẫn đúng. Lọc `role` thì `total` tính theo role. Index: `IDX_users_created_at_id`, `IDX_users_role_created_at_id` (§6).

### 1.12 `UserDto` (chốt 2026-11-20, v2.3)

Dùng chung cho `POST /auth/register` (`data`), `GET /auth/me`, `PATCH /users/me`, `GET /admin/users`:

| Trường | Kiểu | Ghi chú |
|---|---|---|
| `id` | uuid | |
| `email` | string | |
| `fullName` | string | |
| `role` | `TENANT` / `LANDLORD` / `ADMIN` | |
| `status` | `PENDING_VERIFICATION` / `ACTIVE` / `LOCKED` | Thêm ở v2.3 |
| `phone` | string hoặc `null` | Thêm ở v2.3; `null` khi chưa khai |
| `createdAt` | date-time | |

Không có `password_hash`, `email_verified_at`, `locked_*` (danh sách trắng ở `UserDto.from`). Route 10, 14 trả cặp token như route 2, không trả `UserDto`.

## 2. API nội bộ

| Method, đường dẫn | Bên gọi | Kết quả | Hợp đồng |
|---|---|---|---|
| `GET /internal/users/:id/bank-account` | payment (S3) | `200 { userId, bankName, accountHolder, accountNumber }`; chưa khai → `404 IDENTITY_BANK_ACCOUNT_NOT_FOUND` | Tạo `contracts/openapi/identity-internal.v1.yaml` ở T0.3 |

API nội bộ trả số đầy đủ để quản trị viên chuyển khoản (hợp đồng `identity-internal.v1.yaml`, chốt 2026-11-16). Payment không lưu và không log số đầy đủ; chỉ lưu bản chụp bốn số cuối (`RE.PAYOUT`). `:id` không phải UUID → `400 VALIDATION_FAILED` (message "id phải là UUID", `createUuidParamPipe` của template). Body `200` đúng bốn trường `userId, bankName, accountHolder, accountNumber` (schema `additionalProperties: false`): không có `accountLast4`, `updatedAt`. Identity không log số tài khoản, kể cả ở access log. Giải mã lỗi → `500 INTERNAL_ERROR` (§1.4).

## 3. Sự kiện phát

| Sự kiện | Khi nào |
|---|---|
| `identity.registered` | Đăng ký thành công |

## 4. Catalog mã lỗi

| Mã | HTTP | Thông báo | Quy tắc | Nguồn |
|---|---|---|---|---|
| `IDENTITY_EMAIL_TAKEN` | 409 | Email này đã được đăng ký | BR-02 | Code |
| `IDENTITY_INVALID_CREDENTIALS` | 401 | Email hoặc mật khẩu không đúng | | Code |
| `IDENTITY_INVALID_REFRESH_TOKEN` | 401 | Refresh token không hợp lệ hoặc đã hết hạn, hãy đăng nhập lại | | Code |
| `IDENTITY_USER_NOT_FOUND` | 404 | Không tìm thấy người dùng | | Đề xuất |
| `IDENTITY_BANK_ACCOUNT_NOT_FOUND` | 404 | Chưa khai tài khoản nhận tiền | | Đề xuất |
| `IDENTITY_PHONE_TAKEN` | 409 | Số điện thoại đã được dùng | B9 | Đề xuất |
| `IDENTITY_EMAIL_NOT_VERIFIED` | 403 | Email chưa được xác minh, hãy nhập mã OTP | FR01 | Đề xuất |
| `IDENTITY_ACCOUNT_LOCKED` | 403 | Tài khoản đã bị khóa | Bảng 2.6 | Đề xuất |
| `IDENTITY_OTP_INVALID` | 400 | Mã OTP không đúng hoặc đã hết hạn | Bảng 2.6 | Đề xuất |
| `IDENTITY_OTP_RESEND_TOO_SOON` | 429 | Vui lòng chờ trước khi gửi lại mã | Bảng 2.6 | Đề xuất |
| `IDENTITY_RESET_TOKEN_INVALID` | 400 | Liên kết đặt lại mật khẩu không hợp lệ hoặc đã hết hạn | Bảng 2.6 | Đề xuất |
| `IDENTITY_GOOGLE_TOKEN_INVALID` | 401 | Không xác thực được tài khoản Google | Bảng 2.6 | Đề xuất |
| `IDENTITY_ROLE_REQUIRED` | 400 | Hãy chọn vai trò cho tài khoản mới | BR-01 | Đề xuất |
| `IDENTITY_CANNOT_LOCK_SELF` | 409 | Không thể khóa tài khoản của chính mình | | Đề xuất |

## 5. Biến môi trường

| Biến | Mặc định | Ý nghĩa |
|---|---|---|
| `PORT` | `3001` | |
| `DATABASE_URL` | `postgres://identity_user:…@localhost:5433/identity_db` | |
| `REDIS_URL`, `REFRESH_TOKEN_REDIS_PREFIX` | bắt buộc, `identity:` | |
| `JWT_PRIVATE_KEY_PATH` / `JWT_PRIVATE_KEY` | bắt buộc một | Ký RS256 |
| `JWT_PUBLIC_KEY_PATH` / `JWT_PUBLIC_KEY` | bắt buộc một | |
| `JWT_ISSUER` | `realestate-identity` | |
| `JWT_ACCESS_TTL_SECONDS`, `JWT_REFRESH_TTL_SECONDS` | `900`, `604800` | |
| `RABBITMQ_URL`, `OUTBOX_RELAY_ENABLED` | | Chỉ phát |
| `BANK_ACCOUNT_ENCRYPTION_KEY` | bắt buộc; base64 giải ra đúng 32 byte | Khóa AES-256-GCM mã hóa số tài khoản. Sai độ dài hoặc thiếu → service in lỗi rồi dừng (`env.validation.ts`). Dev: sinh bằng `node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"`, không commit |
| `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASSWORD`, `MAIL_FROM` | `SMTP_PORT` mặc định `587` (v2.5); dev: `smtp.gmail.com`, `465`, địa chỉ Gmail, App Password (chỉ ở `.env`), `Tên <địa chỉ Gmail>`. Bắt buộc `SMTP_HOST`, `MAIL_FROM` | Gửi OTP, link đặt lại (B10). Không còn Mailpit (C27, v2.5) |
| `OTP_TTL_SECONDS`, `OTP_MAX_ATTEMPTS`, `OTP_RESEND_COOLDOWN_SECONDS` | `300`, `5`, `60` | Báo cáo Bảng 2.6 |
| `PASSWORD_RESET_TTL_SECONDS` | `900` | Đề xuất |
| `PASSWORD_RESET_URL` | `http://localhost:3000/reset-password` | Trang Next.js |
| `GOOGLE_CLIENT_ID` | trống (tùy chọn) | `aud` của ID token. Trống: service vẫn chạy, log `warn` lúc khởi động, route 14 trả `503 DEPENDENCY_UNAVAILABLE` (§1.8 dòng 0) |

## 6. DDL

Đã có (`1731000000000-create-identity-tables.ts`):

```sql
CREATE TABLE users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email text NOT NULL,
  password_hash text,                       -- null cho tài khoản chỉ đăng nhập Google
  full_name varchar(200) NOT NULL,
  role text NOT NULL CHECK (role IN ('TENANT','LANDLORD','ADMIN')),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX "UQ_users_email_lower" ON users (lower(email));

CREATE TABLE user_identities (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider text NOT NULL CHECK (provider IN ('google')),
  provider_user_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
-- UNIQUE (provider, provider_user_id), UNIQUE (user_id, provider)
```

Thêm (migration mới, B9, B10, C2):

```sql
ALTER TABLE users
  ADD COLUMN phone varchar(20),
  ADD COLUMN status text NOT NULL DEFAULT 'ACTIVE'
    CHECK (status IN ('PENDING_VERIFICATION','ACTIVE','LOCKED')),
  ADD COLUMN email_verified_at timestamptz,
  ADD COLUMN locked_at timestamptz,
  ADD COLUMN locked_by uuid,
  ADD COLUMN lock_reason varchar(500);
CREATE UNIQUE INDEX "UQ_users_phone" ON users (phone) WHERE phone IS NOT NULL;
-- v2.3: tài khoản có trước migration đã dùng được nên coi là đã xác minh
UPDATE users SET email_verified_at = created_at WHERE status = 'ACTIVE';
```

Tài khoản đã có trước migration giữ `ACTIVE` (mặc định) và được điền `email_verified_at = created_at` (v2.3), để khóa rồi mở khóa không đưa họ về `PENDING_VERIFICATION` (§1.9); đăng ký mới ghi `PENDING_VERIFICATION`. `seed:admin` và `seed:users` ghi `status = 'ACTIVE'`, `email_verified_at = now()` (v2.3).

Index cho route 8 (migration `1732000000001-add-users-list-indexes`, chốt 2026-11-19; truy vấn `[WHERE role = ?] ORDER BY created_at DESC, id DESC`, khớp thứ tự nên không cần bước Sort):

```sql
CREATE INDEX "IDX_users_created_at_id" ON users (created_at DESC, id DESC);
CREATE INDEX "IDX_users_role_created_at_id" ON users (role, created_at DESC, id DESC);
```

Chốt 2026-11-16:

```sql
CREATE TABLE bank_accounts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  bank_name varchar(100) NOT NULL,
  account_holder varchar(200) NOT NULL,
  account_number_encrypted bytea NOT NULL,  -- iv(12) ‖ authTag(16) ‖ ciphertext, AES-256-GCM, AAD = user_id (§1.4)
  account_last4 char(4) NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "UQ_bank_accounts_user" UNIQUE (user_id),
  CONSTRAINT "FK_bank_accounts_user" FOREIGN KEY (user_id) REFERENCES users(id)
);
```

## 7. Đã chốt 2026-11-16

1. Route 6–7: `bankName` tự do 2–100 ký tự, `accountNumber` `^\d{6,19}$`, một người một tài khoản (`PUT` ghi đè). Đường dẫn route 1–16 và API nội bộ chốt 2026-11-13.
2. `phone`: `^0\d{9}$`.
3. `BANK_ACCOUNT_ENCRYPTION_KEY` (AES-256-GCM, 32 byte base64). Số đầy đủ chỉ đi qua API nội bộ cho payment.

## 8. Đã chốt 2026-11-18 (v2.1)

1. Route 6–7 trả thêm `updatedAt`; `PUT` luôn `200`, ghi đè bằng một câu `INSERT … ON CONFLICT`; `accountHolder` 1–200 ký tự sau khi cắt khoảng trắng (§1.4).
2. Định dạng mã hóa `iv ‖ authTag ‖ ciphertext`, AAD = `userId`; giải mã lỗi → `500`; không xoay khóa (§1.4).
3. Route 8: `page`, `pageSize` (20/50), `role?`, sắp `created_at DESC, id DESC`, tối đa hai truy vấn, hai index (§1.11, §6).
4. Khai tài khoản nhận tiền khi rút lần đầu hoặc hoàn lần đầu, không có mục riêng ở hồ sơ (§1.4).
