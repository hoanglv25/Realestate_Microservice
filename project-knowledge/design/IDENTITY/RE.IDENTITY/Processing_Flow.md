# RE.IDENTITY — Luồng xử lý

| | |
|---|---|
| **Chức năng** | Đăng ký và xác minh OTP, đăng nhập (mật khẩu, Google), quên mật khẩu, làm mới, đăng xuất, khóa tài khoản, cung cấp tài khoản nhận tiền |
| **Tham chiếu** | `API_Spec.md`, `Component_Class_Design.md`, `services/identity/README.md` |
| **Chủ sở hữu / Cập nhật / Phiên bản** | hoang.lv — 2026-11-28 — v2.5 |

## 1. Đăng ký

```mermaid
sequenceDiagram
    participant C as Client
    participant I as identity
    participant DB as identity_db
    C->>I: POST /api/v1/auth/register
    I->>I: validate DTO, role ∈ {TENANT, LANDLORD}
    I->>I: argon2id(password)
    I->>DB: BEGIN, INSERT users, INSERT outbox_events(identity.registered), COMMIT
    alt vi phạm UQ_users_email_lower (23505)
        I-->>C: 409 IDENTITY_EMAIL_TAKEN
    else
        I-->>C: 201
    end
```

Hai request đồng thời cùng email: ràng buộc duy nhất quyết định, một bên `409`. Số truy vấn: 2.

## 2. Đăng nhập và làm mới

```mermaid
sequenceDiagram
    participant C as Client
    participant I as identity
    participant DB as identity_db
    participant R as Redis
    C->>I: POST /auth/login
    I->>DB: SELECT user theo lower(email)
    I->>I: verify argon2 (sai → 401 chung)
    I->>R: lưu sha256(refresh), familyId mới
    I-->>C: accessToken 15', refreshToken 7 ngày
    C->>I: POST /auth/refresh
    I->>R: Lua: kiểm used, đánh dấu used, tạo token mới cùng họ
    alt token đã used
        I->>R: revoked:<familyId> = 1
        I-->>C: 401 IDENTITY_INVALID_REFRESH_TOKEN
    else
        I-->>C: cặp token mới
    end
```

Redis dừng: đăng nhập, làm mới `503`; service khác vẫn kiểm access token còn hạn bằng khóa công khai.

## 3. ~~Đổi vai trò~~ — bỏ 2026-11-18

Vai trò cố định từ lúc tạo tài khoản. Muốn vai trò khác thì đăng ký tài khoản mới bằng email khác (`API_Spec.md §1`).

## 3a. Xác minh email OTP

```mermaid
sequenceDiagram
    participant C as Client
    participant I as identity
    participant DB as identity_db
    participant R as Redis
    participant M as SMTP
    C->>I: POST /auth/register
    I->>DB: BEGIN, INSERT users (PENDING_VERIFICATION), outbox identity.registered, COMMIT
    I-->>C: 201 (không chờ phần dưới)
    I--)R: SET identity:otp:<userId> {otpHash, attempts=0} EX 300, SET cooldown EX 60
    I--)M: email OTP (lỗi chỉ log warn)
    C->>I: POST /auth/verify-otp {email, otp}
    I->>DB: SELECT user theo lower(email), status = PENDING_VERIFICATION
    I->>R: HGETALL otp, so khớp, sai thì HINCRBY attempts (lần 5 thì DEL)
    I->>R: DEL otp
    I->>DB: UPDATE users SET status='ACTIVE' WHERE id AND status='PENDING_VERIFICATION'
    I->>R: tạo họ refresh token
    I-->>C: 200 cặp token
```

Gửi OTP không chờ (v2.3): `201` trả ngay sau commit; SMTP hoặc Redis lỗi chỉ ghi log `warn`, người dùng gửi lại. Số truy vấn DB: đăng ký 2, xác minh 2.

## 3b. Quên mật khẩu

1. `forgot-password`: tìm user (1 truy vấn); có và không `LOCKED` → `SET identity:pwreset:<sha256(token)> userId EX 900`, gửi email link (không chờ, v2.3). Luôn `202`.
2. `reset-password`: `GETDEL` token (dùng một lần, nguyên tử) → `UPDATE users SET password_hash` → `revokeAllForUser`. Token sai → `400`.

## 3c. Đăng nhập Google

```mermaid
sequenceDiagram
    participant C as Next.js
    participant G as Google
    participant I as identity
    participant DB as identity_db
    C->>G: Google Sign-In
    G-->>C: ID token
    C->>I: POST /auth/google {idToken, role?}
    I->>I: kiểm chữ ký (JWKS Google), aud, exp, email_verified
    I->>DB: SELECT user_identities (google, sub)
    alt chưa liên kết, email đã có
        I->>DB: INSERT user_identities, PENDING_VERIFICATION → ACTIVE, password_hash = null
    else chưa có tài khoản
        I->>DB: BEGIN, INSERT users (ACTIVE) + user_identities + outbox, COMMIT
    end
    I-->>C: 200 cặp token (hoặc 400 IDENTITY_ROLE_REQUIRED, 403 LOCKED)
```

Google không phản hồi khi tải JWKS: `503 DEPENDENCY_UNAVAILABLE`; khóa JWKS được cache theo `Cache-Control`. `GOOGLE_CLIENT_ID` không đặt: cũng `503 DEPENDENCY_UNAVAILABLE`, trước khi kiểm token (v2.3). Email đã có tài khoản nhưng tài khoản đó đã liên kết với một `sub` Google khác: `401 IDENTITY_GOOGLE_TOKEN_INVALID`, không liên kết (`API_Spec §1.8` dòng 4a, v2.4).

## 3d. Khóa tài khoản

1. `UPDATE users SET status='LOCKED' … WHERE id AND status <> 'LOCKED'` (commit trước để chặn đăng nhập mới).
2. `revokeAllForUser`. Redis lỗi → `503`; gọi lại khóa chạy lại bước 2 (idempotent).
3. Người bị khóa: refresh `401`, đăng nhập `403`; access token còn hạn tối đa 15 phút.

## 4. Payment lấy tài khoản nhận tiền

`GET /internal/users/:id/bank-account` → đọc 1 dòng, giải mã, trả. Chỉ đọc nên payment được retry. Identity dừng → payment trả `503` khi tạo lệnh rút (`architecture.md §4`).

## 5. Đã chốt 2026-11-16

1. ~~Thu hồi phiên lỗi sau đổi vai trò → `503`, gọi lại để thu hồi (§3).~~ Hết hiệu lực 2026-11-18 (bỏ đổi vai trò); khóa tài khoản vẫn theo `API_Spec.md §1.9`.
