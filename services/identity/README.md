# @realestate/identity

Identity-service: đăng ký (xác minh email bằng OTP), đăng nhập (mật khẩu, Google), quên mật khẩu, khóa tài khoản và phát hành JWT cho cả hệ thống. Cổng **3001**, DB `identity_db`.
Dựng từ `services/_template-nest` nên dùng chung log JSON, correlation ID, định dạng lỗi, health
check và outbox (đọc README của template cho các phần đó).

## Chức năng

| Endpoint (`/api/v1`)                    | Công khai | Mô tả                                                                                                                                                                                                                      |
| --------------------------------------- | --------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `POST /auth/register`                   | có        | Đăng ký (`TENANT`/`LANDLORD`, `phone` tùy chọn). Tạo tài khoản `PENDING_VERIFICATION`, gửi OTP qua email. 409 `IDENTITY_EMAIL_TAKEN` / `IDENTITY_PHONE_TAKEN`                                                              |
| `POST /auth/verify-otp`                 | có        | `{ email, otp }`: đúng thì `ACTIVE` và trả cặp token. 400 `IDENTITY_OTP_INVALID` (sai, hết hạn, quá 5 lần)                                                                                                                 |
| `POST /auth/resend-otp`                 | có        | Gửi lại OTP, luôn 202; 429 `IDENTITY_OTP_RESEND_TOO_SOON` trong 60 giây                                                                                                                                                    |
| `POST /auth/login`                      | có        | `accessToken` (15 phút), `refreshToken` (7 ngày). Sai email hay mật khẩu: cùng 401 `IDENTITY_INVALID_CREDENTIALS`; đúng mật khẩu mà chưa xác minh / bị khóa: 403 `IDENTITY_EMAIL_NOT_VERIFIED` / `IDENTITY_ACCOUNT_LOCKED` |
| `POST /auth/forgot-password`            | có        | Gửi link đặt lại mật khẩu, luôn 202 (không lộ email có tài khoản)                                                                                                                                                          |
| `POST /auth/reset-password`             | có        | `{ token, newPassword }`: 204, thu hồi mọi phiên. 400 `IDENTITY_RESET_TOKEN_INVALID`                                                                                                                                       |
| `POST /auth/google`                     | có        | `{ idToken, role? }`: kiểm ID token Google; lần đầu cần `role` (400 `IDENTITY_ROLE_REQUIRED`). `GOOGLE_CLIENT_ID` trống: 503                                                                                               |
| `POST /auth/refresh`                    | có        | Đổi refresh token lấy cặp mới. Token cũ chỉ dùng được một lần. Lỗi: 401 `IDENTITY_INVALID_REFRESH_TOKEN`                                                                                                                   |
| `POST /auth/logout`                     | có        | Thu hồi cả họ refresh token của phiên này. Luôn 204                                                                                                                                                                        |
| `GET /auth/me`                          | không     | Thông tin người đang đăng nhập (`UserDto`: có `status`, `phone`)                                                                                                                                                           |
| `PATCH /users/me`                       | không     | Sửa `fullName`, `phone` (`null` xóa số). 409 `IDENTITY_PHONE_TAKEN`                                                                                                                                                        |
| `GET`, `PUT /users/me/bank-account`     | không     | Tài khoản nhận tiền (T2.1)                                                                                                                                                                                                 |
| `GET /admin/users`                      | `ADMIN`   | Danh sách người dùng, phân trang (T2.1)                                                                                                                                                                                    |
| `POST /admin/users/:id/lock`, `/unlock` | `ADMIN`   | Khóa (body `{ reason }`, thu hồi mọi phiên, idempotent), mở khóa (về `ACTIVE` nếu đã xác minh email, ngược lại `PENDING_VERIFICATION`)                                                                                     |

Email (OTP, link đặt lại mật khẩu) gửi **nền, không chờ**: lỗi SMTP chỉ ghi log `warn`, response không đổi. Không còn Mailpit (C27):
dev gửi thật qua Gmail của nhóm, điền `SMTP_USER`, `SMTP_PASSWORD` (App Password), `MAIL_FROM` vào `.env`.

Tài khoản `ADMIN` **không** đăng ký qua API; tạo bằng script seed (bên dưới).
Swagger: `http://localhost:3001/api/docs`.

## Định dạng response

Mọi response theo khung chung của template (xem README template, mục 2.1):

```jsonc
// POST /api/v1/auth/login → 200
{ "data": { "accessToken": "…", "refreshToken": "…", "tokenType": "Bearer", "expiresIn": 900 },
  "meta": { "correlationId": "abc-123", "timestamp": "2026-11-06T10:00:00.000Z" } }

// lỗi → 401
{ "error": { "code": "IDENTITY_INVALID_CREDENTIALS", "message": "Email hoặc mật khẩu không đúng" },
  "meta": { "correlationId": "abc-123", "timestamp": "2026-11-06T10:00:00.000Z" } }
```

`POST /logout` trả 204 không có body; `/health` giữ body phẳng.

## Cấu trúc thư mục

Code nghiệp vụ nằm trong `src/identity/`, chia theo vai trò của file:

```text
src/identity/
  identity.module.ts           ghép các phần bên dưới thành module
  controllers/                 nhận request HTTP, gọi service (auth.controller.ts)
  services/                    logic: auth.service (luồng), password.service (argon2id), token.service (JWT)
  stores/                      lưu refresh token: interface + cài đặt Redis (Lua)
  dto/                         dữ liệu vào/ra của API, có validate
  entities/                    bảng DB: users, user_identities
  errors/                      mã lỗi nghiệp vụ IDENTITY_*
  config/                      kiểm tra biến môi trường bắt buộc của identity
  seed/                        tạo ADMIN (seed-admin) và người dùng dev (seed-users)
```

File test `*.spec.ts` nằm cạnh file được test. Phần dùng chung của template giữ nguyên:
`src/common/` (auth, lỗi, log), `src/messaging/` (outbox, inbox), `src/database/` (migration), `src/health/`.

## Thiết kế

### Hai loại token

|                            | Access token                                    | Refresh token                        |
| -------------------------- | ----------------------------------------------- | ------------------------------------ |
| Dạng                       | JWT RS256 (`sub`, `roles`, `iss`, `exp`, `jti`) | 32 byte ngẫu nhiên, base64url        |
| Lưu ở server               | Không                                           | Redis, chỉ lưu **SHA-256** của token |
| Service khác kiểm tra bằng | Khóa công khai, không hỏi identity              | Chỉ identity dùng                    |
| Thu hồi trước hạn          | Không (vì thế chỉ sống 15 phút)                 | Có                                   |

Identity ký bằng **khóa riêng**; mọi service khác chỉ cần **khóa công khai** (`JWT_PUBLIC_KEY_PATH`).

### Xoay vòng refresh token

Mỗi lần đăng nhập tạo một "họ" (`familyId`). Mỗi lần refresh: token cũ bị đánh dấu đã dùng, token mới
cùng họ được cấp. Nếu token đã dùng bị gửi lại (nghi bị đánh cắp), **cả họ bị thu hồi** và người
dùng phải đăng nhập lại. Việc đổi chạy trong một script Lua của Redis để hai request đồng thời cùng
token không thể cùng thành công.

```text
Redis  identity:rt:<sha256(token)>   hash {userId, familyId, used}   TTL 7 ngày
       identity:revoked:<familyId>   "1" khi cả họ bị thu hồi        TTL 7 ngày
```

Redis sập thì đăng nhập/refresh trả 503; các service khác vẫn kiểm tra được access token đang có.
Lớp lưu trữ nằm sau interface `RefreshTokenStore`, đổi sang nơi khác chỉ cần cài đặt mới.

### Đăng ký và event

`INSERT users` và ghi event `identity.registered` vào outbox nằm **cùng một transaction**; relay gửi
lên RabbitMQ (exchange `domain.events`) sau khi commit. Trùng email được phát hiện bằng ràng buộc
duy nhất `lower(email)` của DB, nên hai request đăng ký đồng thời vẫn chỉ một cái thành công.
Identity **chỉ publish, không consume** (`RABBITMQ_QUEUE` để trống).

### Xác minh email bằng OTP

Đăng ký ghi `status = PENDING_VERIFICATION`. Sau commit, `EmailVerificationService.issue` sinh OTP 6 số và lưu **băm**
`sha256(userId:otp)` trong Redis (`identity:otp:<userId>`, TTL 5 phút, tối đa 5 lần thử, gửi lại sau 60 giây), rồi `MailService`
gửi thư nền. Bộ đếm lần thử tăng bằng script Lua **trước** khi so mã nên thử song song không né được giới hạn. Redis được kiểm
trước khi ghi DB: Redis dừng thì đăng ký trả 503 và không tạo tài khoản.

### Quên mật khẩu, Google, khóa tài khoản

- Quên mật khẩu: token 32 byte gửi qua email, Redis chỉ giữ `sha256(token)`, dùng một lần (`GETDEL`); đổi mật khẩu xong thu hồi
  mọi phiên.
- Google: frontend lấy ID token (Google Sign-In), `google-auth-library` kiểm chữ ký, `aud` (`GOOGLE_CLIENT_ID`), hạn; email đã có
  tài khoản thì tự liên kết (tài khoản chờ OTP thành `ACTIVE`, mật khẩu bị xóa). Không có `GOOGLE_CLIENT_ID` thì route này trả 503,
  các route khác không ảnh hưởng.
- Khóa: commit `LOCKED` trước, rồi thu hồi mọi phiên; Redis lỗi giữa chừng thì gọi lại khóa (idempotent). Access token đang có
  dùng được tối đa 15 phút.

## Chạy

Yêu cầu: hạ tầng đang chạy (`pnpm infra:up` ở gốc repo).

```powershell
pnpm keys:generate                                   # gốc repo, một lần: tạo secrets/jwt-*.pem
cd services/identity
Copy-Item .env.example .env                          # hoặc để pnpm dev tự tạo
pnpm migration:run                                   # tạo bảng users, user_identities, outbox_events...
pnpm dev                                             # http://localhost:3001
```

Thiếu DB, Redis, RabbitMQ hoặc khóa JWT thì service in danh sách thứ thiếu rồi thoát mã 1.

### Tạo tài khoản ADMIN

```powershell
$env:SEED_ADMIN_EMAIL='admin@example.com'
$env:SEED_ADMIN_PASSWORD='mat-khau-dai-it-nhat-12'   # tối thiểu 12 ký tự, KHÔNG ghi vào .env
pnpm seed:admin                                      # production sau build: node dist/scripts/seed-admin.js
```

Chạy lại an toàn: email đã là ADMIN thì không đổi gì; email đã là người dùng thường thì bị từ chối
(không tự nâng quyền).

### Nạp người dùng dev (T2.4)

3 chủ trọ và 5 người thuê id cố định (bảng id ở `project-knowledge/guides/RE_Docker_Local_Guide.md §5`):

```powershell
$env:SEED_USER_PASSWORD='mat-khau-dai-it-nhat-12'   # tối thiểu 12 ký tự, KHÔNG ghi vào .env
pnpm seed:users                                      # production sau build: node dist/scripts/seed-users.js
```

Chạy lại an toàn (không đổi mật khẩu, không ghi event thêm). Email hoặc id đã dùng cho dòng khác thì báo
lỗi nêu dòng xung đột và hoàn tác cả lần nạp. Chưa ghi `status`, `email_verified_at` (T2.5).

### Biến môi trường riêng của identity

| Biến                                                                 | Mặc định                                    | Ý nghĩa                                                                                            |
| -------------------------------------------------------------------- | ------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| `JWT_PRIVATE_KEY_PATH` / `JWT_PRIVATE_KEY`                           | bắt buộc một trong hai                      | Khóa riêng RS256 để ký (đường dẫn tính từ `services/identity`, hoặc PEM với `\n`)                  |
| `JWT_PUBLIC_KEY_PATH` / `JWT_PUBLIC_KEY`                             | bắt buộc một trong hai                      | Khóa công khai để kiểm tra token ở `/me`                                                           |
| `JWT_ISSUER`                                                         | bắt buộc                                    | Ghi vào token và được kiểm tra khi verify                                                          |
| `JWT_ACCESS_TTL_SECONDS`                                             | 900                                         | Thời hạn access token                                                                              |
| `JWT_REFRESH_TTL_SECONDS`                                            | 604800                                      | Thời hạn refresh token                                                                             |
| `BANK_ACCOUNT_ENCRYPTION_KEY`                                        | bắt buộc                                    | Khóa AES-256-GCM mã hóa số tài khoản nhận tiền: base64 của đúng 32 byte (sinh: xem `.env.example`) |
| `SMTP_HOST`, `SMTP_PORT`, `MAIL_FROM`                                | bắt buộc `SMTP_HOST`, `MAIL_FROM`; cổng 587 | Gửi OTP, link đặt lại mật khẩu. Dev: Gmail (`smtp.gmail.com`, `465`, `Tên <địa chỉ Gmail>`)        |
| `SMTP_USER`, `SMTP_PASSWORD`                                         | trống                                       | Chỉ khi dùng SMTP thật; mật khẩu chỉ ở `.env`                                                      |
| `OTP_TTL_SECONDS`, `OTP_MAX_ATTEMPTS`, `OTP_RESEND_COOLDOWN_SECONDS` | 300, 5, 60                                  | OTP (Báo cáo Bảng 2.6)                                                                             |
| `PASSWORD_RESET_TTL_SECONDS`, `PASSWORD_RESET_URL`                   | 900, `http://localhost:3000/reset-password` | Hạn token, trang Next.js nhận `?token=`                                                            |
| `GOOGLE_CLIENT_ID`                                                   | trống                                       | `aud` của ID token Google. Trống: `POST /auth/google` trả 503, log `warn` lúc khởi động            |
| `REDIS_URL`                                                          | bắt buộc                                    | Nơi lưu refresh token, OTP, token đặt lại mật khẩu                                                 |
| `REFRESH_TOKEN_REDIS_PREFIX`                                         | `identity:`                                 | Tiền tố key Redis                                                                                  |
| `OUTBOX_RELAY_ENABLED`                                               | `true`                                      | `false`: ghi outbox nhưng không gửi (dùng khi test)                                                |

## Test

```powershell
pnpm test          # unit (không cần hạ tầng)
pnpm test:e2e      # e2e hạ tầng chung của template, không cần DB/Redis
pnpm test:infra    # cần hạ tầng đang chạy: Postgres + Redis + RabbitMQ (pnpm infra:up); email bắt bằng transport giả, không cần SMTP
```

`test:infra` dùng schema Postgres, tiền tố key Redis và khóa RSA riêng của test (xóa sau khi chạy),
tắt relay để không đẩy event thử vào queue thật.

## Chưa làm (cố ý để sau)

Chống dò mật khẩu (rate limit riêng của identity; gateway đã giới hạn theo IP), đăng xuất mọi thiết bị do người dùng tự chọn,
lưu refresh token trong cookie `HttpOnly` cho web, cooldown `resend-otp` theo `lower(email)` (`van-de-can-quyet-dinh.md` C21).
