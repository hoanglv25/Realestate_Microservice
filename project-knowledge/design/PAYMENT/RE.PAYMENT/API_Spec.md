# RE.PAYMENT — Đặc tả API

| | |
|---|---|
| **Mã chức năng** | `RE.PAYMENT` — payment order, tích hợp payOS, webhook, tiền đến muộn |
| **Service** | `payment` (cổng 3004) |
| **Quy tắc** | BR-04, BR-07, BR-08, BR-09, BR-10 |
| **Quyết định** | ADR-0009 |
| **CSDL** | `payment_db` / `payment_user`: `payment_orders`, `payos_webhook_events`, `late_payments` (ví: `RE.PAYOUT`) |
| **Chủ sở hữu / Cập nhật / Phiên bản** | hoang.lv — 2026-11-22 — v1.3 |

## 1. API công khai

### `POST /api/v1/payments/payos/webhook`

Quyền: `payos` (không token). Body: nguyên văn của payOS (`code, desc, success, data{ orderCode, amount, reference, transactionDateTime, paymentLinkId, … }, signature`).

| # | Kiểm tra | Kết quả |
|---|---|---|
| 1 | Lưu nguyên văn vào `payos_webhook_events` | Luôn |
| 2 | Chữ ký sai (`PAYOS_CHECKSUM_KEY`) | `result = INVALID_SIGNATURE`, log `warn`, `200` (Báo cáo T09) |
| 3 | `success = false` hoặc `code ≠ '00'` | `result = IGNORED`, `200` |
| 4 | Không có order theo `orderCode` | `result = UNKNOWN_ORDER`, log `warn`, `200` |
| 5 | `amount ≠ payment_orders.amount_vnd` | `result = AMOUNT_MISMATCH`, log `warn`, ví không đổi, `200` (Báo cáo T09); chỉ áp cho order `PENDING`. Order `CANCELLED`/`PAID` → bước 8, 9 với số thực nhận |
| 6 | `reference` đã ghi nhận (`ux_webhook_accepted_reference`) | `result = DUPLICATE`, `200`, không cộng ví (Báo cáo T10) |
| 7 | Order `PENDING` | Ghi nhận đặt cọc (§1.1), `result = PAID`, `200` |
| 8 | Order `CANCELLED` | Tiền đến muộn (§1.2) với **số tiền thực nhận** (kể cả khác tiền cọc), `result = LATE`, `200` |
| 9 | Order `PAID` (reference khác) | Thanh toán hai lần cho một order: xử lý như tiền đến muộn (§1.2), hoàn 100% số thực nhận |

Trả `200` khi đã lưu webhook để payOS không gửi lại vô hạn; trả `5xx` khi DB lỗi để payOS gửi lại. Body `200` cố định `{ "data": { "received": true }, "meta": … }`, không lộ `result` (chốt 2026-11-22). `result` có thêm giá trị tạm `RECEIVED` (đã lưu, chưa có kết quả).

`paid_at` và `paidAt` của sự kiện lấy từ `data.transactionDateTime` (`YYYY-MM-DD HH:mm:ss`, giờ Việt Nam, đọc theo `+07:00`); sai dạng thì lấy giờ hiện tại và log `warn` (chốt 2026-11-22).

#### 1.1 Ghi nhận đặt cọc — một transaction

`UPDATE payment_orders SET status='PAID', paid_at, payos_reference WHERE id AND status='PENDING'` → `wallet_transactions DEPOSIT_IN` + `admin_wallet.balance_vnd += amount` → outbox `payment.deposited` → `payos_webhook_events.result = PAID`.

#### 1.2 Tiền đến muộn (BR-10) — một transaction

`INSERT refund_requests (requester_type='SYSTEM', amount 100%, status='PENDING_ADMIN')` → `INSERT late_payments (… refund_request_id)` → `wallet_transactions LATE_PAYMENT_IN` + `balance_vnd += amount` → outbox `payment.late-payment-credited`. Đơn bên rental giữ `EXPIRED`. Yêu cầu hoàn ghi trước để `late_payments` có ngay `refund_request_id` (chốt 2026-11-22).

## 2. API nội bộ

Tạo `contracts/openapi/payment-internal.v1.yaml` ở T0.3 (A6, A7).

| # | Method, đường dẫn | Bên gọi | Kết quả |
|---|---|---|---|
| a | `POST /internal/payment-orders` | rental (S2) | Tạo order + link. Idempotent theo `depositId` |
| b | `POST /internal/payment-orders/:depositId/cancel` | rental | Hủy link payOS rồi `CANCELLED` |
| c | `GET /internal/payment-orders/:depositId` | rental (đối soát) | Trạng thái order; hỏi payOS nếu `PENDING` mà chưa có link |

### a. Tạo order

Body: `{ depositId, tenantId, ownerId, listingTitle, amountVnd, expiresAt }`.

| # | Điều kiện | Kết quả |
|---|---|---|
| 1 | `expiresAt` ≤ now | `409 PAYMENT_ORDER_EXPIRED` |
| 2 | Đã có order cho `depositId`, `PENDING` có link | `200` order cũ |
| 3 | Đã có order `PAID` | `409 PAYMENT_ORDER_ALREADY_PAID` |
| 4 | Đã có order `CANCELLED` | `409 PAYMENT_ORDER_CANCELLED` |
| 5 | Chưa có | `INSERT payment_orders (PENDING, payos_order_code = nextval)` **trước**, rồi gọi payOS `createPaymentLink(expiredAt = expiresAt)` |
| 6 | payOS lỗi/timeout | `503 PAYMENT_PROVIDER_UNAVAILABLE`; order giữ `PENDING` không link; `SagaReconcileJob` và `HoldExpiryJob` của rental xử lý tiếp |
| 7 | Thành công | Lưu `checkout_url`, `qr_code`, `payos_payment_link_id` → `201 { orderId, payosOrderCode, checkoutUrl, qrCode, expiresAt }` |

### b. Hủy order (BR-09)

| Trạng thái | Hành động | Response |
|---|---|---|
| `PENDING` | payOS `cancelPaymentLink` → `UPDATE ... WHERE status='PENDING'` → `CANCELLED` | `200 { status: 'CANCELLED' }` |
| `PENDING`, `UPDATE` 0 dòng (webhook vừa thắng) | | `409 PAYMENT_ORDER_ALREADY_PAID` |
| `CANCELLED` | Không làm gì | `200` |
| `PAID` | | `409 PAYMENT_ORDER_ALREADY_PAID` |
| Không có | | `404 PAYMENT_ORDER_NOT_FOUND` |
| payOS lỗi | Giữ `PENDING` | `503 PAYMENT_PROVIDER_UNAVAILABLE` |

## 3. Sự kiện phát

| Sự kiện | Khi nào |
|---|---|
| `payment.deposited` (DepositPaid) | §1.1 |
| `payment.late-payment-credited` | §1.2 |

## 4. Catalog mã lỗi

| Mã | HTTP | Thông báo | Quy tắc | Nguồn |
|---|---|---|---|---|
| `PAYMENT_ORDER_NOT_FOUND` | 404 | Không tìm thấy lệnh thanh toán | | Đề xuất |
| `PAYMENT_ORDER_ALREADY_PAID` | 409 | Lệnh thanh toán đã được thanh toán | BR-09 | Báo cáo ("409 khi order đã PAID"), tên đề xuất |
| `PAYMENT_ORDER_CANCELLED` | 409 | Lệnh thanh toán đã hủy | | Đề xuất |
| `PAYMENT_ORDER_EXPIRED` | 409 | Thời gian giữ chỗ đã hết | BR-07 | Đề xuất |
| `PAYMENT_PROVIDER_UNAVAILABLE` | 503 | Cổng thanh toán tạm thời không phản hồi | | Đề xuất |

## 5. Biến môi trường

| Biến | Mặc định | Ý nghĩa |
|---|---|---|
| `PORT` | `3004` | |
| `DATABASE_URL` | `postgres://payment_user:…@localhost:5433/payment_db` | |
| `PAYOS_CLIENT_ID`, `PAYOS_API_KEY`, `PAYOS_CHECKSUM_KEY` | bắt buộc | Môi trường thử nghiệm payOS |
| `PAYOS_RETURN_URL`, `PAYOS_CANCEL_URL` | `http://localhost:3000/payment/return`, `http://localhost:3000/payment/cancel` | Trang của giao diện Next.js; `returnUrl` không phải bằng chứng thanh toán |
| `PAYOS_TIMEOUT_MS` | `2500` | Phải < `PAYMENT_CALL_TIMEOUT_MS` của rental (3000). Không retry tạo link |
| `RABBITMQ_URL` | bắt buộc (từ T3.4a) | Chỉ phát (`payment.deposited`, `payment.late-payment-credited`), không nghe queue |
| `OUTBOX_*` | như template | |

## 6. DDL (đề xuất theo Báo cáo Bảng 3.5)

```sql
CREATE SEQUENCE payos_order_code_seq START 100000;   -- orderCode của payOS là số nguyên

CREATE TABLE payment_orders (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  deposit_id uuid NOT NULL UNIQUE,                  -- một order mỗi đơn (tham chiếu rental, không FK)
  tenant_id uuid NOT NULL, owner_id uuid NOT NULL,
  listing_title varchar(200),
  amount_vnd bigint NOT NULL CHECK (amount_vnd > 0),
  payos_order_code bigint NOT NULL UNIQUE,
  payos_payment_link_id varchar(100),
  checkout_url text, qr_code text,
  status varchar(20) NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING','PAID','CANCELLED')),
  payos_reference varchar(100) UNIQUE,              -- mã giao dịch payOS
  expires_at timestamptz NOT NULL,
  paid_at timestamptz, cancelled_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE payos_webhook_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_code bigint,
  reference varchar(100),
  amount_vnd bigint,
  signature_valid boolean NOT NULL,
  result varchar(30) NOT NULL,     -- PAID, LATE, DUPLICATE, INVALID_SIGNATURE, AMOUNT_MISMATCH, UNKNOWN_ORDER, IGNORED
  raw jsonb NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now()
);
-- Mỗi mã giao dịch payOS chỉ được ghi nhận một lần (BR-08, NFR01)
CREATE UNIQUE INDEX ux_webhook_accepted_reference ON payos_webhook_events (reference) WHERE result IN ('PAID','LATE');

CREATE TABLE late_payments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id uuid NOT NULL REFERENCES payment_orders(id),
  deposit_id uuid NOT NULL,
  amount_vnd bigint NOT NULL,
  payos_reference varchar(100) NOT NULL UNIQUE,
  refund_request_id uuid,
  created_at timestamptz NOT NULL DEFAULT now()
);
```

## 7. Đã chốt 2026-11-16

1. Trạng thái payment order: `PENDING`, `PAID`, `CANCELLED`.
2. Tiền đến muộn sai số tiền, hoặc thanh toán lần hai vào order đã `PAID`: ghi nhận đúng số thực nhận như tiền đến muộn, tạo yêu cầu hoàn 100% số đó.
3. Tạo link payOS lỗi: order giữ `PENDING` không link; job của rental xử lý.
4. `PAYOS_TIMEOUT_MS = 2500`; `returnUrl`, `cancelUrl` ở §5.
5. Không làm job đối soát chủ động với payOS; dựa vào payOS gửi lại webhook. Ghi ở mục hạn chế của báo cáo.

## 8. Điểm `[cần xác nhận]`

1. **[cần xác nhận] `GET` khi `PENDING` chưa có link (§2c).** Thiết kế ghi "hỏi payOS" nhưng không nói dùng kết quả làm gì; tra cứu của SDK payOS không trả `checkoutUrl`. T3.1 chỉ đọc DB. Sổ: `implementation/van-de-can-quyet-dinh.md` C22.
2. **[cần xác nhận] Gọi lại tạo order khi `PENDING` chưa có link (§2a).** T3.1 trả `503 PAYMENT_PROVIDER_UNAVAILABLE`, không gọi lại payOS. Đề xuất tra payOS theo `orderCode` rồi mới tạo lại. Sổ: C23.
