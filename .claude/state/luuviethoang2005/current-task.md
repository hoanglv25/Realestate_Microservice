---
task: T3.4a Webhook payOS, ghi nhận đặt cọc, tiền đến muộn
created: 2026-11-22
status: in_progress
phase: implementation/PHASE-3.md#T3.4a
branch: feature/T3.4a-payos-webhook (từ `develop` tại `8021431`, sau PR #27 T3.2)
---

## Mô tả

Thêm `POST /api/v1/payments/payos/webhook` cho payment (gateway đã có route, quyền `payos`, giữ nguyên body): lưu nguyên văn, kiểm chữ ký bằng SDK, ghi nhận đặt cọc (`PAID`) hoặc tiền đến muộn (`LATE`) trong một transaction, phát `payment.deposited` / `payment.late-payment-credited` qua outbox. Kèm script gửi webhook giả có chữ ký. Sau đó kiểm chứng với **payOS thật** (chuyển từ DoD T3.2; payOS không có sandbox — giao dịch thật, số tiền nhỏ). Người làm: A cùng Claude (2026-11-22). Hạn M2 — 2026-12-04, ước ~6 giờ.

## Thiết kế liên quan

`design/PAYMENT/RE.PAYMENT/` v1.1 (`API_Spec §1, §1.1, §1.2, §3, §6`, `Component_Class_Design §1–§4`, `Processing_Flow §2–§6`), `RE.PAYOUT/API_Spec.md` (DDL ví: `ref_type` = `ORDER`, `LATE_PAYMENT`), ADR-0006 (outbox), ADR-0009 (payOS), `contracts/events/payment.deposited.v1`, `payment.late-payment-credited.v1`. Migration T3.1 đã có đủ bảng (`payos_webhook_events`, `late_payments`, `admin_wallet`, `wallet_transactions`, `refund_requests`). Hợp đồng: **không đổi**.

## Definition of Done

- [x] Test 1–6, 10–12 ở `RE.PAYMENT/Component_Class_Design.md §4` pass (`test`, `test:infra` với Postgres thật cho 1–3, 6, 10, 12) — 2026-11-22
- [x] payment `test` 191/191, `test:e2e` 97/97 (môi trường Claude); `test:infra` **49/49 trên máy A** (2026-11-22 23:09: `storage`, `messaging`, `payos-webhook` 12, `payment-orders` 23; RabbitMQ, S3, Postgres thật); sự kiện kiểm bằng `expectEventMatchesContract`
- [x] `pnpm lint`, `format:check`, `build`, `contracts:check` sạch (4 spec OK)
- [x] Số truy vấn webhook: `PAID` 7, `LATE` 8 — đếm bằng log SQL trong infra-spec; nhánh đua 9 (A chấp nhận 2026-11-22)
- [x] Script webhook giả: `node dist/main.js` (`PAID` → `DUPLICATE` → `INVALID_SIGNATURE`); qua gateway + compose `orderCode` 123 → `200` (A, 23:12)
- [x] **payOS thật** (2026-11-22 23:29): `orderCode` 100001, 2.000đ → `result = PAID`, order `PAID`, ví 2.000, đơn rental `PAID`; ghi ở `implementation/progress.md`
- [x] Walkthrough `guides/RE_Payment_Code_Walkthrough.md` cập nhật; `RE_Docker_Local_Guide.md §6` viết lại (payOS thật, khai URL, §6.1 webhook giả); `CLAUDE.md §2.5`; `RE.PAYMENT` v1.3 + `CHANGELOG.md`

## Các bước thực hiện (tổng quan)

- [x] 1. Đọc context, đối chiếu thiết kế (2026-11-22)
- [x] 2. Quét tái sử dụng + kế hoạch (dưới) — A duyệt cả 5 điểm (2026-11-22)
- [x] 3. TDD: `PayosClient.verify` + provider SDK `webhooks`
- [x] 4. TDD: entity + `WalletService.credit`
- [x] 5. TDD: `DepositCaptureService` (`capture`, `recordLate`)
- [x] 6. TDD: `WebhookService.handle` + controller
- [x] 7. Test hạ tầng (1–3, 6, 10, 12), đếm truy vấn
- [x] 8. Script webhook giả + spec (chữ ký tự ký phải qua `webhooks.verify` của SDK)
- [x] 9. Kiểm chứng script qua compose; walkthrough, guide, `code-review`, commit
- [ ] 10. Kiểm chứng payOS thật cùng A

## Tái sử dụng

Quét `services/_template-nest/src`, `services/payment/src`, `services/rental/src`:

| Nhu cầu | Quyết định | Chỗ có sẵn |
|---|---|---|
| Route công khai không token | DÙNG LẠI | `@Public()` (`src/common/auth/public.decorator.ts`) |
| Outbox trong transaction | DÙNG LẠI | `OutboxService.add(manager, ...)` (`src/messaging`) |
| Nhận biết `23505` theo tên ràng buộc | DÙNG LẠI | hàm trong `payment.errors.ts` (T3.1) |
| Dựng SDK payOS (khóa, timeout, `logLevel: 'off'`) | MỞ RỘNG | `payment.module.ts`: dựng một `PayOS` dùng chung, lấy `.paymentRequests` và `.webhooks` |
| Bọc SDK, không log khóa | MỞ RỘNG | `PayosClient` thêm `verify(raw)` |
| Test: `expectEventMatchesContract`, Postgres thật, đếm truy vấn | DÙNG LẠI | `test/helpers`, `payment-orders.infra-spec.ts` |
| `WebhookService`, `DepositCaptureService`, `WalletService.credit`, `PayosWebhookController`, entity `PayosWebhookEvent`, `LatePayment`, `WalletTransaction`, `AdminWallet`, `RefundRequest`, script webhook giả | VIẾT MỚI | Nghiệp vụ payment (`Component_Class_Design §1`) |

Không chạm `_template-nest`, không thành phần dùng chung mới ngoài `src/payment/`.

## Kế hoạch chi tiết

> A duyệt 2026-11-22 (cả 5 điểm mục B; nhánh đua 9 truy vấn). TDD bật (`warn`).

**Lệch so với kế hoạch khi làm (ghi lại cho minh bạch):**

| Kế hoạch | Thực tế | Lý do |
|---|---|---|
| 5 entity mới | Không tạo | Các bảng chỉ ghi bằng SQL trong transaction, không đọc qua repository: entity sẽ là code chết; SQL thô như `payment-order.service` (`INSERT_ORDER`) |
| `test/payos-webhook.e2e-spec.ts` | Gộp vào infra-spec | Không có DB thì `PaymentModule` không nạp, route không tồn tại ở e2e |
| (không có) | `payment.env.ts` bắt buộc `RABBITMQ_URL`; compose `payment` thêm `RABBITMQ_URL`, `RABBITMQ_EXCHANGE`, chờ `rabbitmq` + `rabbitmq-init`; `services/payment/.env.example` | `OutboxService` thuộc `MessagingModule`; compose cũ không cấp RabbitMQ cho payment nên webhook không phát được sự kiện. Đúng `API_Spec §5` (`RABBITMQ_URL` chỉ phát) |
| SDK dựng riêng `paymentRequests` | Một instance `PAYOS_SDK` dùng chung cho `paymentRequests`, `webhooks` | Một nơi cấu hình khóa, timeout |
| Ghi `result` rồi `capture` | `capture` trước, `result` sau | Nhánh đua 9 thay vì 10 truy vấn; trùng `reference` vẫn bị index chặn ở câu ghi `result` |

### A. Phạm vi

| Có trong T3.4a | Để sau |
|---|---|
| Webhook đủ 9 dòng bảng `API_Spec §1`; `PAID` (§1.1), `LATE` (§1.2, gồm order `PAID` nhận thêm tiền với `reference` khác) | `HoldExpiryJob` (T3.4b) |
| `WalletService.credit` (chỉ cộng) | `debit`, hoàn, rút, chứng từ (T3.6 mở rộng cùng file) |
| Script webhook giả | Khai URL bằng `webhooks.confirm()` — dùng trang my.payos.vn, không viết code |

### B. Điểm cần A quyết (đề xuất của Claude)

| # | Chỗ | Đề xuất |
|---|---|---|
| 1 | **Thiết kế lệch nhau:** `Component_Class_Design §3` kiểm số tiền **trước** trạng thái; `API_Spec §1` dòng 5 nói sai số tiền chỉ áp cho order `PENDING`, order `CANCELLED`/`PAID` ghi muộn với số thực nhận | Theo `API_Spec` (cụ thể hơn, đúng BR-10: tiền đến muộn hoàn 100% số thực nhận). Sửa mã giả §3 cho khớp, `RE.PAYMENT` v1.2 + `CHANGELOG.md` |
| 2 | `paid_at` / `paidAt` của sự kiện | `data.transactionDateTime` của payOS (dạng `YYYY-MM-DD HH:mm:ss`, giờ VN) đọc theo `+07:00`; không đọc được thì `now()` + log `warn` |
| 3 | Body trả về cho payOS | `200` body cố định (không lộ `result` ra ngoài) |
| 4 | Script webhook giả gửi HTTP | Dùng `node:http` (công cụ dev, không phải lời gọi liên service nên không qua `InternalHttpService`); đặt `src/scripts/send-fake-webhook.ts`, lệnh `pnpm --filter @realestate/payment webhook:fake`; khóa đọc từ `PAYOS_CHECKSUM_KEY`, không in khóa |
| 5 | Thứ tự ghi khi `LATE` | Sinh `id` cho `late_payments` trước (`randomUUID`); `INSERT refund_requests` trước `late_payments` để ghi luôn `refund_request_id` (khỏi `UPDATE` thêm) → 8 truy vấn |

### C. File

| File | Việc |
|---|---|
| `src/payment/payment.module.ts` | Dựng một `PayOS`; token `PAYOS_WEBHOOKS`; đăng ký entity, service, controller mới |
| `src/payment/clients/payos.client.ts` (+spec) | `verify(raw): Promise<boolean>` — SDK ném lỗi → `false`, log `warn` không có body |
| `src/payment/entities/` `payos-webhook-event`, `late-payment`, `wallet-transaction`, `admin-wallet`, `refund-request` | Khớp DDL T3.1 |
| `src/payment/services/wallet.service.ts` (+spec) | `credit(m, type, amount, ref)`: INSERT `wallet_transactions` + `UPDATE admin_wallet SET balance_vnd = balance_vnd + $1` |
| `src/payment/services/deposit-capture.service.ts` (+spec) | `capture(m, order, ev)`: `UPDATE ... WHERE id AND status='PENDING'` → ví `DEPOSIT_IN` (`ORDER`, `order.id`) → outbox `payment.deposited`; trả `false` khi 0 dòng. `recordLate(m, order, ev)`: refund `SYSTEM` 100% → `late_payments` → ví `LATE_PAYMENT_IN` (`LATE_PAYMENT`) → outbox `payment.late-payment-credited` |
| `src/payment/services/webhook.service.ts` (+spec) | `handle(raw)` theo bảng `API_Spec §1`; trùng `ux_webhook_accepted_reference` → `DUPLICATE`; lỗi DB khác → ném (500, payOS gửi lại) |
| `src/payment/controllers/payos-webhook.controller.ts` | `@Public() @Post('payments/payos/webhook') @HttpCode(200)` |
| `src/scripts/send-fake-webhook.ts` (+spec), `package.json` | Ký `data` (sắp khóa, `k=v&...`, HMAC-SHA256); tùy chọn `--order-code --amount --reference --bad-signature --url` |
| `test/payos-webhook.infra-spec.ts` | Postgres thật: 1, 2, 3 (song song), 4, 5, 6, 10 (đua hủy/webhook), 11, 12, đếm truy vấn |
| `test/payos-webhook.e2e-spec.ts` | Route công khai không token → 200; body hỏng → vẫn 200, `INVALID_SIGNATURE` |
| `design/PAYMENT/RE.PAYMENT/Component_Class_Design.md`, `CHANGELOG.md` | Mục B1 (nếu A đồng ý) |
| `guides/RE_Payment_Code_Walkthrough.md`, `guides/RE_Docker_Local_Guide.md §6`, `implementation/progress.md` | Tài liệu |

### D. Số truy vấn (`Processing_Flow §6`, ngưỡng 8)

| Nhánh | Truy vấn |
|---|---|
| `PAID` | lưu raw 1 + đọc order 1 + tx (result, UPDATE order, ví tx, số dư, outbox) 5 = **7** |
| `LATE` | lưu raw 1 + đọc order 1 + tx (result, refund, late, ví tx, số dư, outbox) 6 = **8** |
| Sai chữ ký / bỏ qua / không có order / sai tiền | 2–3 |
| Đua (`capture` 0 dòng → đọc lại → `LATE`) | 9, hiếm — ghi walkthrough |

## Blockers / Ghi chú

- Cần A: (1) merge PR T3.2 để tách nhánh; (2) duyệt kế hoạch + mục B; (3) tài khoản payOS + điền 3 khóa vào `.env` (A tự điền, không dán vào chat); (4) chạy đường hầm và quét QR ở bước 10.
- Máy ảo Cowork không push được lên GitHub và không gọi được `localhost` của Windows: A chạy `git push`, compose, lệnh gọi API.
- **2026-11-22 chặng A (payOS thật, chưa trả tiền): PASS.** Qua gateway: landlord1 tạo tin cọc 2.000đ, admin duyệt, tenant1 `POST /deposits` → `201 PENDING_PAYMENT`, `checkoutUrl` `https://pay.payos.vn/web/…` thật; `payment_orders` `payos_order_code=100000`, `amount_vnd=2000`, `PENDING`, có link; `deposits` `PENDING_PAYMENT`. Khóa payOS chạy đúng từ compose. Đơn này không thanh toán, để hết hạn (chưa có `HoldExpiryJob` nên đơn rental giữ `PENDING_PAYMENT`, tin tự nhả theo `held_until`).
- **2026-11-22 code-review 5 chiều (T3.4a): không CRITICAL, không MAJOR.** Security: webhook `@Public` đúng (gateway quyền `payos`), kiểm chữ ký bằng SDK, log không có body/số tài khoản/chữ ký (test), khóa không in; mọi SQL có tham số. Performance: 7/8 (đua 9, A chấp nhận); tìm order theo `uq_payment_orders_order_code`. Correctness: lưu nguyên văn trước; mọi thay đổi tiền + outbox một transaction; không HTTP trong transaction; `UPDATE … WHERE status='PENDING'` đua với hủy (test thật 8 lần); trùng `reference` qua index một phần (5 webhook đồng thời → 1 giao dịch ví); bất biến ví sau mỗi test. Style: đúng `Component_Class_Design §1`, controller mỏng, biến môi trường khai đủ ở `.env.example` + compose, không mã lỗi mới. Reuse: `WalletService` VIẾT MỚI theo Reuse Report; script dùng `NodeCryptoProvider` của SDK; không import chéo service. MINOR: SDK so chữ ký bằng `!==` (không constant-time, phạm vi đồ án); webhook ẩn danh mỗi request ghi một dòng `payos_webhook_events` (giới hạn bởi rate limit IP của gateway).
- **TDD:** unit `payos.client`, `wallet`, `deposit-capture`, `webhook`, `payment.env`, script đều RED trước. `test/payos-webhook.infra-spec.ts` viết sau code → kiểm ngược bằng đột biến: (1) kiểm số tiền trước trạng thái (mã giả cũ) → 1 test đỏ; (2) bỏ `status='PENDING'` trong `UPDATE` → 1 test đỏ; trả lại → 12/12 (tech-debt #22).
- **Còn lại cho A:** (1) ~~`test:infra` đủ 4 file~~ xong 49/49; (2) `docker compose ... up -d --build --no-deps payment` (biến RabbitMQ mới); (3) chặng C: đường hầm, khai URL webhook, quét QR 2.000đ; (4) commit + push + PR.
- **Kết quả payOS thật (2026-11-22 23:29, A):** đường hầm cloudflared → gateway; payOS chấp nhận URL webhook (lần gọi thử `orderCode` 123, chữ ký đúng → `IGNORED`, `200`); `orderCode` 100001 trả 2.000đ thật qua MB → webhook `FT26327657219818` chữ ký đúng, `result = PAID`; `payment_orders` `PAID`, `paid_at` 16:29:01Z (đúng `transactionDateTime` giờ VN); ví 2.000; `payment.deposited` qua RabbitMQ → đơn rental `178b6f9c…` `PAID`, `paid_at` khớp.
- Lần gọi thử của payOS khi khai URL ra `IGNORED` (không phải `UNKNOWN_ORDER` như dự đoán): body thử không phải giao dịch thành công theo luật dòng 3. Đúng thiết kế, vẫn `200`; đã sửa Docker guide.
