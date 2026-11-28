---
task: T3.6 Payout: hoàn, rút, chứng từ, ví
created: 2026-11-25
status: done
phase: implementation/PHASE-3.md#T3.6
branch: feature/T3.6-payout (từ `develop` tại `549977a`, sau PR #31 T3.5)
---

## Mô tả

Payment (`RE.PAYOUT`): ví trung gian trừ tiền (`debit`), yêu cầu hoàn (nội bộ cho rental + quản trị viên hoàn tất/từ chối/thất bại), lệnh rút của chủ trọ (gồm phần còn lại của đơn `REFUNDED`, §1.1), chứng từ chuyển khoản (multipart → `sha256` → S3 `payment-proofs`, BR-17), `audit_log`, route 1–12, `RentalClient`, `IdentityClient`. Nối với T3.5: rental đã gọi `POST /internal/refund-requests` và nghe `refunded`/`refund-rejected`/`withdrawal-completed`. Người làm: A cùng Claude. Hạn M3 — 2026-12-09, ước ~14 giờ. Phụ thuộc T3.5, T2.1 (đã tick).

## Thiết kế liên quan

`design/PAYMENT/RE.PAYOUT/` v1.2 (API_Spec §1–9, Component_Class_Design §1–4, Processing_Flow §1–5); ADR-0009; BR-10, 12, 15, 16, 17, 19. Bảng đã có ở migration `1734000000000` (T3.1): `admin_wallet`, `wallet_transactions`, `refund_requests`, `withdrawal_requests`, `transfer_receipts`, `audit_log`. Hợp đồng **có sẵn, không đổi**: `payment-internal.v1.yaml` (`createRefundRequest`), `rental-internal.v1.yaml` (`withdrawal-eligibility`), `identity-internal.v1.yaml` (`bank-account`), sự kiện `payment.withdrawal-requested/-completed/-failed`, `payment.refunded`, `payment.refund-rejected`. Gateway đã định tuyến route 1–12. **Một `[cần xác nhận]` chạm task:** `API_Spec §9` (quản trị viên xem tài khoản của người thuê khi hoàn) → B1.

## Definition of Done

- [ ] Test 1–14 (gồm 6a) ở `RE.PAYOUT/Component_Class_Design.md §4` pass
- [ ] payment `test`, `test:e2e`, `test:infra` pass (dán output; `test:infra` đủ trên máy A)
- [ ] `pnpm lint`, `pnpm format:check`, `pnpm build`, `pnpm contracts:check` không lỗi
- [ ] Số truy vấn mỗi route đếm bằng log SQL, trong ngưỡng (ghi có tiền 8)
- [x] Kiểm chứng (`PHASE-3.md`): `guides/RE_Report_Defense_Guide.md §4` bước 3–7; truy vấn bất biến ví (E10) (2026-11-25 21:03, compose máy A)
- [x] `RE.PAYOUT` v1.3 + `CHANGELOG.md` (đóng §9); walkthrough payment; `.env.example`, compose (có trên `develop` sau PR #32)
- [ ] Sau merge: tag `v0.5-deposit-flow` (A đặt và push)

## Các bước thực hiện (tổng quan)

- [x] 1. Đọc context, đối chiếu thiết kế (2026-11-25)
- [x] 2. Quét tái sử dụng + kế hoạch chi tiết (A duyệt B1 2026-11-25 18:43, B2–B12 2026-11-25 18:49)
- [x] 3. Thiết kế v1.3 (B1–B12) trước code (2026-11-25; `CHANGELOG.md` v1.3)
- [x] 4. Env + compose (Redis, S3, URL nội bộ); entity; mã lỗi; client (2026-11-25)
- [x] 5. TDD: `refund-amount`, `WalletService.debit`, `AuditService`, `ReceiptService` (2026-11-25; payment `test` 24 suite, 234 PASS)
- [x] 6. TDD: `RefundService` (nội bộ + admin), `WithdrawalService`, `PayoutQueryService`; controller (2026-11-25)
- [x] 7. Test hạ tầng (gồm test 10 đồng thời, E10), đếm truy vấn (2026-11-25; S3 giả trong `payout.infra-spec`, cần A chạy `test:infra` đủ trên máy có S3)
- [x] 8. Kiểm chứng (máy A); walkthrough, `code-review`, commit (không dòng ghi công), PR — merge PR #32 `a076858` 2026-11-25; tag sau merge **chưa đặt**

## Tái sử dụng

> Quét 2026-11-25 · Nguồn: `services/payment/src`, `services/payment/test`, `services/_template-nest/src`, `services/rental/src`, `services/listing/src` (phát hiện trùng), `contracts/`, `services/payment/package.json`, `infra/compose/docker-compose.yml`, gateway `routes.ts` · Cách tra: grep `WalletService|credit|debit|refund_requests|withdrawal|transfer_receipts|audit_log|AuditLog|putObject|StorageService|FileInterceptor|UploadedFile|multer|Idempotent|InternalHttpService|clients/|bank-account|withdrawal-eligibility|Paginated|PageQueryDto`; đọc `wallet.service.ts`, `deposit-capture.service.ts`, `storage.service.ts`, `payment.env.ts`, `feature-flags.ts`, compose `payment`
> Vùng mù: không

| Thành phần cần | Nhóm | Vị trí đã có / lý do viết mới |
|---|---|---|
| Trừ ví (`REFUND_OUT`, `WITHDRAW_OUT`) | MỞ RỘNG | `src/payment/services/wallet.service.ts#WalletService`: thêm `debit` (cùng khuôn `credit`; `CHECK balance_vnd >= 0` → `409 PAYMENT_WALLET_INSUFFICIENT`) và truy vấn bất biến E10 |
| Lưu chứng từ S3 | DÙNG LẠI | `src/storage/storage.service.ts#StorageService.putObject` (template); bucket qua `S3_BUCKETS` |
| Nhận tệp multipart | DÙNG LẠI | `FileInterceptor` của `@nestjs/platform-express` 11.2.8 (đã có, kèm multer); kiểu tệp tự khai (không thêm `@types/multer`) |
| `Idempotency-Key` route 2, 6, 8 | DÙNG LẠI | `src/common/idempotency/idempotent.decorator.ts#Idempotent` (Redis, B11) |
| Gọi rental, identity | DÙNG LẠI | `src/common/http/internal-http.service.ts#InternalHttpService` qua `clients/` |
| Phân loại lỗi lời gọi | VIẾT MỚI (cục bộ) | rental có `classifyCall` nhưng không import chéo service; payment chỉ cần chuyển nguyên 4xx/5xx của `InternalHttpService` → không cần hàm riêng |
| `updatedRows` (`[rows, rowCount]` của `UPDATE ... RETURNING`) | VIẾT MỚI (cục bộ) | Phát sinh khi code (2026-11-25): rental có hàm cùng ý trong `viewing.service.ts` nhưng không import chéo service → `src/payment/services/sql-rows.ts` |
| `insertReceipt` (ghi `transfer_receipts`, trùng `sha256` → 409) | VIẾT MỚI | Dùng chung cho hoàn và rút; đặt trong `receipt.service.ts` |
| Đổi `413` của multer thành `400 PAYMENT_RECEIPT_INVALID` | VIẾT MỚI | `src/payment/http/receipt-too-large.interceptor.ts`; grep `PayloadTooLarge` trong `services/*/src`: chưa có |
| Bộ dựng test unit payout (`fakeDb`, id mẫu) | VIẾT MỚI (test) | `test/helpers/payout-kit.ts`; không vào build |
| `createTestApp` thay provider | MỞ RỘNG (test) | thêm `options.overrides` để thay `ReceiptService` bằng bản S3 giả |

## Đóng task (2026-11-28)

- Merge vào `develop` qua PR #32 (`a076858`, 2026-11-25 21:35); `develop` bắt buộc CI `ci` xanh. Tick bù T3.6 ở `implementation/progress.md` trên nhánh `feature/T1.5-remove-mailpit`.
- Các ô DoD test/lint/đếm truy vấn ở trên để nguyên: output không được dán vào file này lúc làm, không tick bù khi không có bằng chứng.
- Còn lại: tag `v0.5-deposit-flow` (A đặt và push).
