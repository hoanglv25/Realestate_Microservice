# Phase 3 — rental, payment

| | |
|---|---|
| **Chủ sở hữu / Cập nhật** | hoang.lv — 2026-11-18 |

**Mục tiêu:** đặt cọc, hết hạn, tiền đến muộn, bàn giao, giải ngân, hoàn, rút chạy được với payOS thử nghiệm.

**Hạn:** M2 — 2026-12-04 (cuối S4; dời 2026-11-16) cho T3.1–T3.5; T3.6: M3 — 2026-12-09.

**Điều kiện xong:** tag `v0.5-deposit-flow`. Đây là điểm cắt giảm của kế hoạch.

**Phase khó nhất.** Làm đúng thứ tự: thành công → bù trừ → hết hạn → vòng đời → payout.

---

## T3.1 payment: khung, payment order, payOS

| | |
|---|---|
| **Người làm** | A — tự giao lại khi cần (trước 2026-11-18: C) |
| **Thời lượng** | ~10 giờ (ước 2026-11-16) |
| **Hạn** | M2 — 2026-12-04 (dời) |
| **Mã WBS** | E5-1 |
| **Đọc trước** | `design/PAYMENT/RE.PAYMENT/`, ADR-0009 |
| **Phụ thuộc** | T0.3 |

**Các bước:**

1. Service từ template, cổng 3004, `payment_db`; migration `RE.PAYMENT/API_Spec.md §6` và `RE.PAYOUT/API_Spec.md §7`.
2. `PayosClient`: timeout, không retry tạo link.
3. `PaymentOrderService`: tạo (lưu order trước khi gọi payOS), hủy, tra cứu; controller nội bộ.

**Kiểm chứng:**

```powershell
pnpm --filter @realestate/payment test
```

**DoD:** Test 7–10 ở `RE.PAYMENT/Component_Class_Design.md §4` pass.

---

## T3.2 rental: khung, lịch xem, saga luồng thành công

| | |
|---|---|
| **Người làm** | A — tự giao lại khi cần (trước 2026-11-18: C) |
| **Thời lượng** | ~16 giờ (ước 2026-11-16) |
| **Hạn** | M2 — 2026-12-04 (dời); luồng thành công chạy được trước 2026-11-27 |
| **Mã WBS** | E4-1, E4-2, E4-4a |
| **Đọc trước** | `design/RENTAL/RE.VIEWING/`, `design/RENTAL/RE.DEPOSIT_SAGA/` (cả 3 file), ADR-0004 |
| **Phụ thuộc** | T3.1, T2.3 (hoặc mock theo hợp đồng) |

**Các bước:**

1. Service từ template, cổng 3003, `rental_db`, Redis, queue `rental.payment-events`; migration `deposits`, `saga_log`, `viewings`.
2. `ViewingService` + 5 route (đặt lịch, từ chối, xác nhận đã xem, hủy, danh sách); tự hủy yêu cầu `REQUESTED` của người khác trong handler `payment.deposited` (`RE.VIEWING`, chốt 2026-11-16).
3. `ListingLock`, `ListingClient`, `PaymentClient`.
4. `DepositSagaService.start` luồng thành công; `POST /deposits` với `@Idempotent()`.
5. `PaymentEventsHandler` cho `payment.deposited`.

**Kiểm chứng:** đặt cọc qua gateway, mở `checkoutUrl` payOS thử nghiệm, thanh toán, kiểm:

```powershell
docker exec -it re-postgres psql -U rental_user -d rental_db -c "select status, paid_at from deposits order by created_at desc limit 1"
```

**DoD:** Test 1, 2, 9, 14, 15, 18 ở `RE.DEPOSIT_SAGA/Component_Class_Design.md §8` và test 1–10 ở `RE.VIEWING/Component_Class_Design.md §3` pass.

---

## T3.3 Saga: bù trừ, đối soát, đồng bộ listing

| | |
|---|---|
| **Người làm** | A — tự giao lại khi cần (trước 2026-11-18: C) |
| **Thời lượng** | ~10 giờ (ước 2026-11-16) |
| **Hạn** | M2 — 2026-12-04 (dời) |
| **Đọc trước** | `RE.DEPOSIT_SAGA/Processing_Flow.md §3`, `Component_Class_Design.md §5, §7` |
| **Phụ thuộc** | T3.2 |

**Các bước:**

1. `classify(err)`; `CompensationService.cancelAfterHold`.
2. `ListingSyncService` + `SagaReconcileJob` (a), (b).

**Kiểm chứng:**

```powershell
docker compose ... stop payment     # đặt cọc → 503; BĐS về AVAILABLE
docker compose ... start payment
```

**DoD:** Test 3–8, 17 pass (E8).

---

## T3.4 Webhook, hết hạn giữ chỗ, tiền đến muộn

> **Tách 2026-11-22 (A):** T3.4a (webhook, ghi nhận tiền, tiền đến muộn) làm trước để kiểm chứng payOS thật; T3.4b (hết hạn giữ chỗ) sau. payOS không có môi trường thử riêng (giao dịch thật, số tiền nhỏ), nên mục kiểm chứng payOS thật của T3.2 chuyển sang T3.4a.

### T3.4a Webhook payOS, ghi nhận đặt cọc, tiền đến muộn

| | |
|---|---|
| **Người làm** | A |
| **Thời lượng** | ~6 giờ (tách từ ~10 giờ của T3.4) |
| **Hạn** | M2 — 2026-12-04 |
| **Mã WBS** | E4-5 |
| **Đọc trước** | `RE.PAYMENT/API_Spec.md §1`, `Component_Class_Design.md §3–§4`, `Processing_Flow.md §2–§6`, `RE.PAYOUT/API_Spec.md` (DDL ví) |
| **Phụ thuộc** | T3.1, T3.2 |

**Các bước:**

1. `PayosClient.verify`, `WebhookService`, `DepositCaptureService` (PAID, LATE), `POST /api/v1/payments/payos/webhook`.
2. Script giả webhook có chữ ký hợp lệ cho test (sai chữ ký, sai số tiền, trùng, đến muộn).

**Kiểm chứng:**

- Script giả webhook: hợp lệ → order `PAID`, đơn rental `PAID`; gửi lại → `DUPLICATE`; sai chữ ký, sai số tiền → không đổi ví.
- **payOS thật** (chuyển từ T3.2): đường hầm tới gateway 8080, khai URL webhook trên my.payos.vn, tin cọc vài nghìn đồng, quét QR trả tiền → `payos_webhook_events.result = PAID`, đơn rental `PAID`.

**DoD:** Test 1–6, 10–12 ở `RE.PAYMENT/Component_Class_Design.md §4` pass; kiểm chứng payOS thật có kết quả ghi vào `progress.md`.

### T3.4b Hết hạn giữ chỗ

| | |
|---|---|
| **Người làm** | A |
| **Thời lượng** | ~4 giờ |
| **Hạn** | M2 — 2026-12-04 |
| **Mã WBS** | E4-4b |
| **Đọc trước** | `RE.DEPOSIT_SAGA/Processing_Flow.md §4` |
| **Phụ thuộc** | T3.4a |

**Các bước:** `HoldExpiryJob`: hủy link trước, `EXPIRED` sau.

**Kiểm chứng:** `HOLD_TTL_SECONDS=60`, không thanh toán → đơn `EXPIRED` trong ≤ 70 giây, BĐS `AVAILABLE` (E4). Gửi webhook giả sau đó → `late_payments` (E5).

**DoD:** Test 11–13, 16 ở `RE.DEPOSIT_SAGA` pass.

---

## T3.5 Vòng đời đơn

| | |
|---|---|
| **Người làm** | A — tự giao lại khi cần (trước 2026-11-18: B (chuyển từ C 2026-11-16; C review PR)) |
| **Thời lượng** | ~10 giờ (ước 2026-11-16) |
| **Hạn** | M2 — 2026-12-04 (dời) |
| **Mã WBS** | E4-3, E4-6 |
| **Đọc trước** | `design/RENTAL/RE.DEPOSIT_LIFECYCLE/` |
| **Phụ thuộc** | T3.4 |

**Các bước:** `deposit-state.ts` + test; route 1–7; bảng `audit_log` ghi khi bàn giao (B12); `AutoReleaseJob`, `DeadlineJob`; `withdrawal-eligibility` gồm đơn `REFUNDED` (BR-15 sửa); handler `refunded`, `refund-rejected`, `withdrawal-completed`.

**Kiểm chứng:** rút `AUTO_RELEASE` → đơn `RELEASED`, BĐS `RENTED` (E6).

**DoD:** Test 1–16 (gồm 13a, 14a, 14b) ở `RE.DEPOSIT_LIFECYCLE/Component_Class_Design.md §5` pass.

---

## T3.6 Payout: hoàn, rút, chứng từ, ví

| | |
|---|---|
| **Người làm** | A — tự giao lại khi cần (trước 2026-11-18: C) |
| **Thời lượng** | ~14 giờ (ước 2026-11-16) |
| **Hạn** | M3 — 2026-12-09 (dời) |
| **Mã WBS** | E5-3, E5-4, E5-5 |
| **Đọc trước** | `design/PAYMENT/RE.PAYOUT/` |
| **Phụ thuộc** | T3.5, T2.1 |

**Các bước:** `WalletService`, `RefundService`, `WithdrawalService` (gồm rút phần còn lại của đơn `REFUNDED`, `RE.PAYOUT §1.1`), `ReceiptService`, `AuditService`; route 1–12; `RentalClient`, `IdentityClient`. `Idempotency-Key` dùng `@Idempotent()` Redis (B11).

**Kiểm chứng:** luồng đầy đủ ở `guides/RE_Report_Defense_Guide.md §4` bước 3–7; truy vấn bất biến ví (E10).

**DoD:** Test 1–14 (gồm 6a) ở `RE.PAYOUT/Component_Class_Design.md §4` pass. Đặt tag `v0.5-deposit-flow`.
