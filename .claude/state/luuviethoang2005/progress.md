---
task: T3.6 Payout: hoàn, rút, chứng từ, ví
updated: 2026-11-25
percent: 5
---

## Đang làm
- Bước 2: kế hoạch chi tiết đã ghi `current-task.md`, chờ A duyệt (B1–B12)

## Đã xong (phiên này)
- T3.5 merge (PR #31, `549977a`), tick (`7629978`)
- Nhánh `feature/T3.6-payout`; đọc thiết kế, hợp đồng, code payment; Reuse Report

## Còn lại
- Bước 3–8 theo `current-task.md`

## Blockers
_không có_

## 2026-11-25 — T3.6 bước 3–5

- Bước 3: `RE.PAYOUT` v1.3 (route 13, 14; §1.1–1.5, §2, §4, §6, §8a; §9 đóng; test 15–17), `CHANGELOG.md`.
- Bước 4: `payment.env.ts` bắt buộc `REDIS_URL`, `S3_*` (có `payment-proofs`), `INTERNAL_RENTAL_URL`, `INTERNAL_IDENTITY_URL`; `env.validation.ts` thêm 2 URL + `RECEIPT_MAX_BYTES`; `.env.example` gốc và payment; compose payment (Redis, S3, URL, `depends_on` redis, s3; sửa thẳng trên máy A, giữ thay đổi Swagger chưa commit của A). 9 mã lỗi; 4 entity; `RentalClient`, `IdentityClient` (`404 IDENTITY_BANK_ACCOUNT_NOT_FOUND` → `null`).
- Bước 5: `refund-amount.ts` (test 1), `WalletService.debit` (`UPDATE` trước, `23514` → `409 WALLET_INSUFFICIENT` + log error) + `invariant` (E10), `AuditService`, `ReceiptService` (cỡ, loại, byte đầu, `sha256`, S3 lỗi → 503).
- Kiểm: `pnpm --filter @realestate/payment test` → 24 suite, 234 test PASS (bản sao trong môi trường Claude).

## 2026-11-25 — T3.6 bước 6–7

- Bước 6: `RefundService` (nội bộ 70%, hoàn tất, từ chối, thất bại), `WithdrawalService` (tạo, hoàn tất, thất bại), `PayoutQueryService` (route 1, 3, 4, 5, 11, 12, 13, 14), 4 controller (`refund-requests.internal`, `transactions`, `withdrawals`, `admin-payouts`), `ReceiptTooLargeInterceptor`, `PaymentModule` (multer `RECEIPT_MAX_BYTES`, `ReceiptService` nhận S3 tùy chọn).
- Bước 7: `payout.infra-spec.ts` 25 test (test 2–17, E10 sau mỗi test, số truy vấn, hợp đồng), Postgres + Redis thật, rental/identity/S3 giả. Kiểm độ nhạy: đổi 70→80 và bỏ kiểm byte đầu → 4 test đỏ, khôi phục.
- Số truy vấn đo bằng log SQL: hoàn tất (route 6, 8) 7; từ chối 3; thất bại hoàn 2; thất bại rút 3; tạo lệnh rút ≤ 6 (1 đọc + INSERT + outbox); nội bộ ≤ 3; route 1, 3: 2; route 11: 1; route 13, 14: 1 + 1 lời gọi identity.
- Kiểm (bản sao trong môi trường Claude, Postgres 16 + Redis + RabbitMQ cài trực tiếp, không S3):
  - `pnpm --filter @realestate/payment test` → 29 suite, 275 PASS
  - `test:e2e` → 11 suite, 97 PASS
  - `test:infra` (trừ `storage.infra-spec` cần S3) → 4 suite, 68 PASS
  - `pnpm lint`, `pnpm format:check`, `pnpm contracts:check` (4 spec OK), `pnpm build` → sạch
- 47 file chép về máy A, so sha256 khớp 47/47. Compose sửa thẳng trên máy A.
- Còn: A chạy `test:infra` đủ (có S3) + kiểm chứng compose (mục F); walkthrough; `code-review`; commit (không dòng ghi công), PR.

## 2026-11-25 20:21 — T3.6 kiểm trên máy A (`.claude/logs/t36-verify.log`)

- `pnpm infra:check` → 28/28 OK.
- `pnpm --filter @realestate/payment test:infra` → 5 suite, 74 test PASS (gồm `storage.infra-spec` với S3 thật, `payout.infra-spec` 25 test).
- Compose `--profile dev --profile apps up -d --build payment` → exit 0; `/health` → `{"status":"ok","checks":{"redis":"up","rabbitmq":"up","s3":"up","db":"up"}}`; log khởi động map đủ route 1–14 và `POST /internal/refund-requests`.
- Lần chạy trước 20:08 đỏ 74/74 vì Docker Desktop chưa chạy (`ECONNREFUSED :5433`), không phải lỗi code.
- Còn: kiểm chứng luồng compose (mục F, bước 3–7), walkthrough, `code-review`, commit, PR.

## 2026-11-25 21:03 — T3.6 kiểm chứng compose (mục F) ĐẠT (`.claude/logs/t36-demo.ps1`, log `t36-demo.log`)

Qua gateway, webhook payOS giả có chữ ký hợp lệ, mốc demo (`HOLD_TTL_SECONDS=60`, `REFUND_WINDOW_SECONDS=30`, `AUTO_RELEASE_SECONDS=120`):
- Luồng A (21:00, bước 3–5): đặt cọc → `PAID` → tin `DEPOSITED` → bàn giao, xác nhận, nhận phòng → `RELEASED`, tin `RENTED` → route 2 tạo lệnh rút 2.000đ (bản chụp … 3344) → rút lần hai `409 PAYMENT_PAYOUT_ALREADY_OPEN` → route 13 có số đầy đủ → route 6 tải chứng từ → `COMPLETED` → đơn `WITHDRAWN`.
- Luồng B (21:03, `-OnlyB`, bước 7 + 6a): đặt cọc → `PAID` → xin hoàn trong hạn → payment có yêu cầu `TENANT` 1.400đ → route 14 có số người thuê → route 8 hoàn tất → đơn `REFUNDED`, tin `AVAILABLE` → rút 600đ (2.000 − 1.400) → hoàn tất → đơn giữ `REFUNDED`, có `withdrawn_at`.
- E10: số dư 17.002.000 = Σ vào − Σ ra; ví về 0 cho đơn B; số dư không đổi sau luồng; `audit_log` COMPLETE_REFUND, COMPLETE_WITHDRAWAL; `wallet_transactions` DEPOSIT_IN 2000, REFUND_OUT 1400, WITHDRAW_OUT 600.
- Lần chạy B đầu (21:01) dừng ở đặt cọc: payOS thật không trả lời (`PAYMENT_PROVIDER_UNAVAILABLE` trong log `re-payment`, T3.1), hệ thống trả 503 và `HoldExpiryJob` hủy order đúng thiết kế; script thêm thử lại 3 lần.
- Mật khẩu `landlord1`, `tenant1` được A đặt lại qua luồng quên mật khẩu (`dat-lai-mk.ps1`).

### 2026-11-25 — code-review 5 chiều (T3.6)
- Đã sửa: đổi tên `admin-payouts.controller.ts` → `payouts.admin.controller.ts` (class `PayoutsAdminController`, theo coding-convention); thêm trạng thái nguồn của từ chối / thất bại vào API_Spec §1.3 + CHANGELOG v1.3; thêm `http/` vào project-structure.md.
- Chạy lại sau sửa (container): unit 275/275, e2e 97/97, infra 68/68 (trừ storage); lint, format:check, build, contracts:check (4 spec) đều OK.
- MAJOR còn mở: thiếu index route 4, 5, 12 (tech-debt #25) — chờ A chọn sửa trong T3.6 hay để sau.
- MINOR: `refundAmountVnd(1)` = 0 → vi phạm CHECK nếu cọc 1đ (không xảy ra với mức cọc thực tế); `PAYOUT_URLS` fallback `''` (env validation đã bắt buộc nên không tới được).
- File cũ `admin-payouts.controller.ts` trên máy A chưa xóa (chưa từng commit) — xóa trong script commit.

### 2026-11-25 — sửa MAJOR index (A chọn sửa trong T3.6)
- Thiết kế trước: API_Spec §7 thêm 7 index (route 3 bị sót ở tech-debt #25, cùng 4, 5, 12); CHANGELOG v1.3 dòng 4.
- TDD: 7 test EXPLAIN trong `payout.infra-spec.ts` (đúng SQL của `page()`, tắt seq scan) → RED 7/7 → migration `1764000000000-add-payout-list-indexes.ts` → GREEN 7/7.
- Migration lên → hoàn tác → lên: 7 → 0 → 7 index.
- Chạy lại (container): unit 275/275, e2e 97/97, infra 75/75 (trừ storage); lint, format:check, build OK.
- Walkthrough cập nhật (file migration, số test 32, câu hỏi vấn đáp, hạn chế route 12 chỉ lọc targetType). Tech-debt #25 → resolved.

### 2026-11-25 21:2x — chạy script commit trên máy A
- lint, format, contracts, build, unit 275, e2e 97 đạt; infra 80/81: `payment-orders.infra-spec` (T3.1) "gọi lại 1" nhận 2. Script dừng, chưa commit.
- debug: tái hiện trong container với `OUTBOX_POLL_INTERVAL_MS=100` (3/3 đỏ); truy vấn dư = `SELECT … FROM outbox_events` của `OutboxRelay`. Không do code T3.6.
- Sửa (A chọn commit riêng): thêm bộ lọc như `payos-webhook.infra-spec`. Sau sửa: 100 ms 3/3 đạt 23/23; infra 75/75 (container); lint OK. Script commit tạo 2 commit.
