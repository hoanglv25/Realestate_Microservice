# Phase 2 — identity, listing

| | |
|---|---|
| **Chủ sở hữu / Cập nhật** | hoang.lv — 2026-11-26 |

**Mục tiêu:** identity đủ phần payment cần; listing đủ API công khai và nội bộ cho saga.

**Hạn:** M1 — 2026-11-27 (cuối S3; dời 2026-11-16). T2.5: M2 — 2026-12-04.

**Điều kiện xong:** API nội bộ listing chạy đúng hợp đồng T0.3.

---

## T2.1 identity: tài khoản nhận tiền, API nội bộ

| | |
|---|---|
| **Người làm** | A |
| **Thời lượng** | ~8 giờ (ước 2026-11-16) |
| **Hạn** | M1 — 2026-11-27 (dời) |
| **Mã WBS** | E2-4, E2-5, E2-6 |
| **Đọc trước** | `design/IDENTITY/RE.IDENTITY/` |
| **Phụ thuộc** | T0.1 (B9 chốt: giữ `users.role`), T0.3 |

**Các bước:**

1. Migration `bank_accounts`; `BankAccountService` (AES-GCM, bốn số cuối).
2. Route 6–8 ở `API_Spec.md §1` (route 9 đổi vai trò bỏ 2026-11-18); `users.internal.controller.ts`.
3. `revokeAllForUser` trong store (T2.5 dùng khi khóa tài khoản, đặt lại mật khẩu).
4. Test `expectEventMatchesContract` cho `identity.registered`.

**Kiểm chứng:**

```powershell
pnpm --filter @realestate/identity test
pnpm --filter @realestate/identity test:infra
```

**DoD:** Test 1–9, 11, 12 ở `RE.IDENTITY/Component_Class_Design.md §5` pass (test 10 bỏ 2026-11-18).

---

## T2.2 listing: khung, CRUD sản phẩm, duyệt, ảnh

| | |
|---|---|
| **Người làm** | A — tự giao lại khi cần (trước 2026-11-18: B) |
| **Thời lượng** | ~14 giờ (ước 2026-11-16) |
| **Hạn** | M1 — 2026-11-27 (dời) |
| **Mã WBS** | E3-1, E3-2, E3-3 |
| **Đọc trước** | `design/LISTING/RE.LISTING/`, ADR-0010 |
| **Phụ thuộc** | T1.2 |

**Các bước:**

1. Tạo service từ template, cổng 3002, `listing_db`, S3 bucket `listing-images`.
2. Migration theo DDL `API_Spec.md §6` (GiST, `held_by_deposit_id`).
3. `ListingCommandService`, `ListingReviewService`, `ListingImageService`.
4. Thêm vào compose và `routes.ts` của gateway (nhờ A).

**Kiểm chứng:**

```powershell
pnpm --filter @realestate/listing test
pnpm --filter @realestate/listing test:infra
```

**DoD:** Test 1–3, 12 ở `RE.LISTING/Component_Class_Design.md §3` pass (Báo cáo T04, T18).

---

## T2.3 listing: tìm kiếm PostGIS, API nội bộ giữ chỗ

| | |
|---|---|
| **Người làm** | A — tự giao lại khi cần (trước 2026-11-18: B) |
| **Thời lượng** | ~10 giờ (ước 2026-11-16) |
| **Hạn** | M1 — 2026-11-27 (dời) |
| **Mã WBS** | E3-4, E3-5 |
| **Đọc trước** | `RE.LISTING/API_Spec.md §1.3, §2`, `Processing_Flow.md §3` |
| **Phụ thuộc** | T2.2, T0.3 |

**Các bước:**

1. `ListingQueryService.search` với `ST_DWithin`, phân trang, chỉ tin `APPROVED`.
2. `listings.internal.controller.ts`: `GET`, `holds`, `status`.
3. Test đồng thời 50 lời giữ chỗ với Postgres thật.

**Kiểm chứng:**

```sql
EXPLAIN SELECT ... WHERE ST_DWithin(location, ST_MakePoint(105.84, 21.00)::geography, 2000);  -- dùng ix_listings_location
```

**DoD:** Test 4–11 pass; ví dụ trong `listing-internal.v1.yaml` khớp response thật.

---

## T2.4 listing: seed dữ liệu

| | |
|---|---|
| **Người làm** | A — tự giao lại khi cần (trước 2026-11-18: B) |
| **Thời lượng** | ~3 giờ (ước 2026-11-16) |
| **Hạn** | M1 — 2026-11-27 (dời) |
| **Mã WBS** | E3-7 |
| **Phụ thuộc** | T2.3, T2.1 (tài khoản chủ trọ) |

**Các bước:** script nạp 30 tin có tọa độ thật ở Hà Nội, 3 chủ trọ, 5 người thuê (theo kế hoạch sprint); tài khoản seed ở `ACTIVE` (bỏ qua OTP); id cố định để Postman và k6 dùng; chạy lại an toàn.

**DoD:** `guides/RE_Docker_Local_Guide.md §5` liệt kê đúng id seed. Chạy lại `EXPLAIN` bán kính 2 km (`ST_DWithin(location, ST_MakePoint(105.84, 21.00)::geography, 2000)`) trên seed thật và dán plan (chốt 2026-11-20, `RE.LISTING §7` mục 15). Seed chỉ ~30 dòng nên planner có thể chọn `Seq Scan`: ghi đúng plan nhận được; việc dùng `ix_listings_location` đã được chứng minh ở test 4 (T2.3) với ~5.000 dòng.

---

## T2.5 identity: xác minh OTP, quên mật khẩu, Google, khóa tài khoản, số điện thoại

| | |
|---|---|
| **Người làm** | A |
| **Thời lượng** | ~12 giờ (ước 2026-11-16) |
| **Hạn** | M2 — 2026-12-04 (dời) |
| **Mã WBS** | Ngoài file xlsx (thêm theo quyết định B10, C2 ngày 2026-11-12) |
| **Đọc trước** | `design/IDENTITY/RE.IDENTITY/API_Spec.md §1.1–1.10`, `Processing_Flow.md §3a–3d` |
| **Phụ thuộc** | T2.1 (`revokeAllForUser`) |

**Các bước:**

1. Thêm Mailpit vào `infra/compose/docker-compose.yml` (profile dev), biến `SMTP_*`, `MAIL_FROM` vào `.env.example` và `env.validation.ts`.
2. Migration `users`: `phone`, `status`, `email_verified_at`, `locked_*`, `UQ_users_phone`. Đăng ký ghi `PENDING_VERIFICATION`; đăng nhập kiểm trạng thái sau mật khẩu.
3. `MailService` (nodemailer), `EmailVerificationService`, route 10–11.
4. `PasswordResetService`, route 12–13.
5. `GoogleAuthService` dùng `google-auth-library`, route 14.
6. Khóa, mở khóa (route 16), `PATCH /users/me` (route 15).
7. Cập nhật bảng định tuyến gateway (`RE.GATEWAY §3` dòng 1–3).

**Kiểm chứng:**

```powershell
pnpm --filter @realestate/identity test
pnpm --filter @realestate/identity test:infra
```

Đăng ký qua gateway rồi mở Mailpit `http://localhost:8025` thấy email OTP.

**DoD:** Test 13–23 (gồm 22a) ở `RE.IDENTITY/Component_Class_Design.md §5` pass.

---

## T2.6 listing: danh mục tỉnh/thành, quận/huyện; tin đăng dùng `cityId`, `districtId`

> Task ngoài kế hoạch, thêm 2026-11-26 theo yêu cầu người dùng. **Chưa nhận được** cho tới khi A duyệt C25 (`van-de-can-quyet-dinh.md`) và thiết kế qua `architect-reviewer`.

| | |
|---|---|
| **Người làm** | A — tự giao lại khi cần |
| **Thời lượng** | ~6 giờ (ước 2026-11-26) `[cần xác nhận]` |
| **Hạn** | `[cần xác nhận]` — A chốt (M1 2026-11-27 không kịp) |
| **Mã WBS** | Ngoài file xlsx |
| **Đọc trước** | `design/LISTING/RE.LOCATION/` (v1.0), `design/LISTING/RE.LISTING/CHANGELOG.md` v1.5, `RE.GATEWAY` v1.4 |
| **Phụ thuộc** | T2.2, T2.3, T2.4 (sửa code đã merge của ba task này) |

**Các bước:**

1. Đối chiếu danh sách 80 quận/huyện (`RE.LOCATION/API_Spec.md §6`) với nguồn chính thức trước 1/7/2025; ghi nguồn vào comment migration.
2. Migration `1733200000000-create-locations.ts`, entity `City`, `District`, `LocationQueryService`, `LocationsController` (route 1, 2 `RE.LOCATION`).
3. Migration `1733300000000-listings-location-ids.ts` (`RE.LISTING/API_Spec.md §6.1`); sửa entity, DTO, SQL, presenter, `listing-edit.rules`, `ListingCommandService` theo bảng v1.5 ở `RE.LISTING/Component_Class_Design.md §1`.
4. Seed `seed:listings` ghi id bằng truy vấn con theo tên; cập nhật fixture test.
5. Gateway: dòng 6a ở `services/api-gateway/src/gateway/routes.ts` + test `route-resolver.spec.ts`.
6. Xuất lại `services/listing/openapi.json`; báo repo giao diện đổi form tạo/sửa tin, bộ lọc tìm kiếm.

**Kiểm chứng:**

```powershell
pnpm --filter @realestate/listing test
pnpm --filter @realestate/listing test:infra
pnpm --filter @realestate/api-gateway test
pnpm --filter @realestate/listing openapi:export
```

Qua gateway: `GET /api/v1/cities` không token trả 5 tỉnh; `GET /api/v1/districts?cityId=<Hà Nội>&pageSize=50` trả 30; tạo tin với cặp đúng trả `201` có tên tỉnh, quận.

**DoD:** Test 1–9 ở `RE.LOCATION/Component_Class_Design.md §3` và test 18, 22–26 ở `RE.LISTING/Component_Class_Design.md §3` pass; test cũ của listing, gateway vẫn pass; walkthrough `RE_Listing…` cập nhật (CLAUDE.md §8).
