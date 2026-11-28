# Phase 1 — Nền tảng và gateway

| | |
|---|---|
| **Chủ sở hữu / Cập nhật** | hoang.lv — 2026-11-18 |

**Mục tiêu:** client gọi được identity qua gateway; CI chạy trên mọi PR.

**Hạn:** 2026-11-20 (cuối S2; dời từ M0 2026-11-13 ngày 2026-11-16).

**Điều kiện xong:** tag `v0.1-skeleton`.

---

## T1.1 CI

| | |
|---|---|
| **Người làm** | A — tự giao lại khi cần (trước 2026-11-18: B) |
| **Thời lượng** | ~5 giờ (ước 2026-11-16) |
| **Hạn** | S2 — 2026-11-20 (dời từ M0) |
| **Mã WBS** | E1-1 |
| **Đọc trước** | `guides/RE_OpenAPI_Postman_Guide.md §6`, `standards/git-workflow.md` |
| **Phụ thuộc** | Không |

**Các bước:**

1. `.github/workflows/ci.yml`: cache pnpm, `pnpm lint`, `pnpm format:check`, `pnpm contracts:check`, `pnpm build`, `test` và `test:e2e` theo ma trận service.
2. Bật bảo vệ nhánh `main`, `develop`: bắt buộc PR và check `ci` xanh; không bắt buộc người duyệt (chốt 2026-11-18).

**Kiểm chứng:** mở PR cố ý làm hỏng một schema trong `contracts/events/` → CI đỏ.

**DoD:** CI xanh trên `develop`; nhánh được bảo vệ.

---

## T1.2 api-gateway

| | |
|---|---|
| **Người làm** | A |
| **Thời lượng** | ~12 giờ, gồm ~3 giờ vá template (ước 2026-11-16) |
| **Hạn** | S2 — 2026-11-20 (dời từ M0) |
| **Mã WBS** | E1-2, E1-3, E1-4 |
| **Đọc trước** | `design/SHARED/RE.GATEWAY/` (cả 3 file), ADR-0003 |
| **Phụ thuộc** | T0.1; C7 đã chốt 2026-11-16 (`RE.GATEWAY/API_Spec.md §6`) |

**Các bước:**

0. Sửa `services/_template-nest` trước khi tạo service mới (chốt 2026-11-16), rồi chép sang identity; test template vẫn xanh:
   - C18: đưa `OUTBOX_RELAY_ENABLED` từ identity vào template.
   - C14: `InternalHttpService` gắn `details.outcome` (`NOT_EXECUTED` khi chưa gửi được request, còn lại `UNKNOWN`), thêm test ở `test/http-client.e2e-spec.ts` (`RE.SERVICE_TEMPLATE/API_Spec.md §3`).
   - `.env.example` gốc: `HTTP_TIMEOUT_MS=3000` (A2).
1. Tạo `services/api-gateway` từ template (skill `service-scaffold`, `RE.SERVICE_TEMPLATE/Component_Class_Design.md §3`), không bật DB.
2. `routes.ts` theo `RE.GATEWAY/API_Spec.md §3`; `RouteResolver`.
3. `InternalBlockMiddleware`, `AccessGuard` (JWT RS256 bằng khóa công khai), throttler.
4. `ProxyMiddleware`: timeout, đổi lỗi kết nối thành `503/504`, giữ body thô cho webhook.

**Kiểm chứng:**

```powershell
pnpm --filter @realestate/api-gateway test
curl.exe -i http://localhost:8080/internal/listings/x                      # 404
curl.exe -i http://localhost:8080/api/v1/auth/me -H "Authorization: Bearer sai"  # 401 AUTH_TOKEN_INVALID
```

**DoD:** Test 1–12 ở `RE.GATEWAY/Component_Class_Design.md §4` pass; template có `OUTBOX_RELAY_ENABLED` và `details.outcome`.

---

## T1.3 Compose profile `apps`, identity sau gateway

| | |
|---|---|
| **Người làm** | A |
| **Thời lượng** | ~3 giờ (ước 2026-11-16) |
| **Hạn** | S2 — 2026-11-20 (dời từ M0) |
| **Đọc trước** | `guides/RE_Docker_Local_Guide.md`, `services/_template-nest/README.md §6` |
| **Phụ thuộc** | T1.2 |

**Các bước:**

1. Thêm `api-gateway`, `identity` vào `infra/compose/docker-compose.yml` profile `apps`; mount khóa JWT; `INTERNAL_*_URL` dùng tên service.
2. Chỉ gateway publish cổng `127.0.0.1:8080`.

**Kiểm chứng:**

```powershell
docker compose --env-file .env -f infra/compose/docker-compose.yml --profile dev --profile apps up -d --build
curl.exe -X POST http://localhost:8080/api/v1/auth/register -H "Content-Type: application/json" -d '{\"email\":\"t1@x.com\",\"password\":\"Matkhau@123\",\"fullName\":\"T1\",\"role\":\"TENANT\"}'
```

**DoD:** Đăng ký, đăng nhập, `/me` qua 8080; cùng `X-Request-ID` ở log gateway và identity. Đặt tag `v0.1-skeleton`.

---

## T1.4 Object storage chuyển sang Cloudflare R2, gỡ container Silo

> Task ngoài kế hoạch, thêm 2026-11-26 theo ADR-0016 và C26 (A chốt 2026-11-26).

| | |
|---|---|
| **Người làm** | A |
| **Thời lượng** | ~6 giờ (ước 2026-11-26) `[cần xác nhận]` |
| **Hạn** | `[cần xác nhận]` — A chốt; cần xong trước khi deploy lên Render |
| **Mã WBS** | Ngoài file xlsx |
| **Đọc trước** | `decisions/0016-object-storage-cloudflare-r2-bo-silo.md`, `van-de-can-quyet-dinh.md` C26 và mục D 2026-11-26, `design/SHARED/RE.SERVICE_TEMPLATE/` (v2.1), `guides/RE_Docker_Local_Guide.md` |
| **Phụ thuộc** | Bucket `listing-images`, `payment-proofs` và token R2 đã tạo (2026-11-26); T2.2, T3.x (sửa code đã merge) |

**Các bước:**

1. Sửa thiết kế trước: `RE.SERVICE_TEMPLATE` v2.2 (bỏ tạo bucket lúc khởi động, test hạ tầng S3), `RE.LISTING/Processing_Flow.md` nhãn S3; kèm `CHANGELOG.md`.
2. `services/_template-nest`: xóa `ensureBucket`, `ensureBucketsWithRetry`, `bucketsReady`, `onApplicationBootstrap` khỏi `StorageService`; test hạ tầng S3 tự bỏ qua khi `.env` gốc không cấu hình S3. Chép sang api-gateway, identity, listing, payment, rental.
3. Test hạ tầng của listing đọc `S3_*` từ `.env` gốc thay vì `localhost:9000`; test ảnh tự xóa key đã tải.
4. `infra/compose/docker-compose.yml`: gỡ service `s3`, volume `s3_data`, `depends_on: s3`; listing, payment lấy `S3_*` từ `.env`. `infra/scripts/check-infra.*` bỏ kiểm `re-s3`.
5. `.env.example` gốc và của service, README, `RE_Docker_Local_Guide.md`, `security-policy.md`, `architecture.md`, walkthrough liên quan.

**Kiểm chứng:**

```powershell
pnpm --filter @realestate/template-nest test
pnpm --filter @realestate/listing test
pnpm --filter @realestate/payment test
pnpm --filter @realestate/listing test:infra
pnpm --filter @realestate/payment test:infra
pnpm lint; pnpm format:check; pnpm build; pnpm contracts:check
pnpm infra:up; pnpm infra:check
```

Compose profile `apps`: listing, payment khởi động không có log tạo bucket; `/health` có `checks.s3 = "up"`; upload ảnh qua gateway lưu lên R2.

**DoD:** Không còn container `s3`; test unit, e2e của mọi service pass; `test:infra` của listing, payment pass với R2; test S3 bỏ qua (không fail) khi `.env` không có S3; tài liệu và walkthrough cập nhật (CLAUDE.md §8).

---

## T1.5 Gỡ Mailpit, email identity qua SMTP thật

> Task ngoài kế hoạch, thêm 2026-11-28 theo C27 (A chốt 2026-11-28).

| | |
|---|---|
| **Người làm** | A |
| **Thời lượng** | ~3 giờ (ước 2026-11-28) |
| **Hạn** | `[cần xác nhận]` — A chốt |
| **Mã WBS** | Ngoài file xlsx |
| **Đọc trước** | `van-de-can-quyet-dinh.md` C27 và mục D 2026-11-28, `design/IDENTITY/RE.IDENTITY/` (v2.4), `guides/RE_Identity_Code_Walkthrough.md`, `guides/RE_Docker_Local_Guide.md` |
| **Phụ thuộc** | T2.5 (đã merge); tài khoản Gmail gửi thư + App Password của nhóm |

**Các bước:**

1. Sửa thiết kế trước: `RE.IDENTITY` v2.5 (bỏ Mailpit ở API_Spec §5, Processing_Flow, test 13 của Component_Class_Design); kèm `CHANGELOG.md`. Sửa `business-spec/RE.SRS.md`, `RE.BUSINESS_RULES.md`.
2. identity: mặc định `SMTP_PORT` 587 (`env.validation.ts`, test trước); `test:infra` thay `test/helpers/mailpit.ts` bằng transport giả `test/helpers/mail-capture.ts` (`startIdentityInfra` override `MAIL_TRANSPORT`).
3. `infra/compose/docker-compose.yml`: gỡ service `mailpit`, `depends_on: mailpit`; identity lấy `SMTP_*`, `MAIL_FROM` từ `.env`.
4. `.env.example` gốc và của identity (mẫu Gmail, bỏ `MAILPIT_*`), README, `architecture.md`, `domain-glossary.md`, `RE_Docker_Local_Guide.md`, walkthrough identity.

**Kiểm chứng:**

```powershell
docker rm -f re-mailpit
pnpm --filter @realestate/identity test
pnpm --filter @realestate/identity test:e2e
pnpm --filter @realestate/identity test:infra
pnpm lint; pnpm format:check; pnpm build; pnpm contracts:check
pnpm infra:up
```

`docker ps` không có `re-mailpit`. identity `pnpm dev` với SMTP Gmail: đăng ký qua Swagger → OTP về hộp thư thật → `verify-otp` trả cặp token.

**DoD:** Không còn container `mailpit`; identity `test`, `test:e2e`, `test:infra` pass không cần SMTP; tài liệu, Báo cáo v2 (`business-spec/`) và walkthrough cập nhật (CLAUDE.md §8).
