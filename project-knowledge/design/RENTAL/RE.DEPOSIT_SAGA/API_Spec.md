# RE.DEPOSIT_SAGA — Đặc tả API

| | |
|---|---|
| **Mã chức năng** | `RE.DEPOSIT_SAGA` — đặt cọc qua nhiều service, bù trừ, hết hạn giữ chỗ, đối soát |
| **Service** | `rental` (cổng 3003) — bên điều phối |
| **Quy tắc** | BR-04, BR-05, BR-06, BR-07, BR-09, BR-18 |
| **Quyết định** | ADR-0004 (saga tại rental), ADR-0005 (bản chụp), ADR-0009 (payOS) |
| **CSDL** | `rental_db`: `deposits`, `saga_log`, `outbox_events`, `processed_events`; Redis (khóa theo tin, idempotency) |
| **Chủ sở hữu / Cập nhật / Phiên bản** | hoang.lv — 2026-11-22 — v1.3 |

## 1. `POST /api/v1/deposits`

Quyền: `tenant`. Header bắt buộc: `Idempotency-Key` (`@Idempotent()`).

| Trường | Kiểu | Ràng buộc |
|---|---|---|
| `listingId` | uuid | bắt buộc |

Số tiền **không** nhận từ client (BR-04): lấy từ bản chụp listing.

### Kết quả

| HTTP | Khi nào |
|---|---|
| `201` | Giữ chỗ và tạo link thành công |
| `409 LISTING_NOT_AVAILABLE` | BĐS không `AVAILABLE`, chưa duyệt, hoặc người khác đã giữ (Báo cáo T06, T07) |
| `409 RENTAL_DEPOSIT_IN_PROGRESS` | Không lấy được khóa Redis theo tin |
| `409 IDEMPOTENCY_IN_PROGRESS`, `422 IDEMPOTENCY_KEY_REUSED` | Theo template |
| `503 UPSTREAM_UNAVAILABLE` | Listing hoặc payment chắc chắn chưa xử lý; chỗ giữ (nếu có) đã được nhả |
| `504 UPSTREAM_TIMEOUT` | Không rõ kết quả; đơn giữ `PENDING_PAYMENT`, `SagaReconcileJob` xử lý tiếp |

`201`:

```json
{ "data": {
    "depositId": "uuid", "status": "PENDING_PAYMENT", "listingId": "uuid",
    "amountVnd": 3000000, "expiresAt": "2026-11-10T08:10:00.000Z", "holdRemainingSeconds": 598,
    "checkoutUrl": "https://pay.payos.vn/...", "qrCode": "000201..." },
  "meta": { "correlationId": "…", "timestamp": "…" } }
```

### Thứ tự kiểm tra và các bước

| # | Bước | Lỗi → kết quả |
|---|---|---|
| 1 | Idempotency (interceptor) | Như template |
| 2 | Redis `SET lock:listing:{id} <token> NX PX <DEPOSIT_LOCK_TTL_MS>` | Không lấy được → `409 RENTAL_DEPOSIT_IN_PROGRESS` |
| 3 | `ListingClient.getSnapshot(listingId)` | `404` → `404 LISTING_NOT_FOUND`; không `APPROVED`/`AVAILABLE` → `409 LISTING_NOT_AVAILABLE`; lỗi → `503`/`504` |
| 4 | Sinh `depositId`; `ListingClient.hold(listingId, depositId, now + HOLD_TTL_SECONDS)` | `409` → trả `409`; `503` → trả `503`; `504` → trả `504` (chưa có đơn; `held_until` tự hết) |
| 5 | Transaction: `INSERT deposits (PENDING_PAYMENT, bản chụp)` + `saga_log HOLD_LISTING OK` + outbox `rental.deposit-created` | DB lỗi → bù trừ nhả chỗ, `500` |
| 6 | `PaymentClient.createOrder(depositId, amountVnd, expiresAt)` | Xem `Processing_Flow.md §3` |
| 7 | Transaction: lưu `payment_order_id`, `checkout_url`, `qr_code`; `saga_log CREATE_PAYMENT_ORDER OK` | |
| 8 | Nhả khóa Redis (so token) | |

## 2. Lời gọi ra ngoài

| Tới | Lệnh | Retry | Hợp đồng |
|---|---|---|---|
| listing | `GET /internal/listings/:id` | Có | `RE.LISTING/API_Spec.md §2` |
| listing | `POST /internal/listings/:id/holds` | **Không** | như trên |
| listing | `PUT /internal/listings/:id/status` | Có | như trên |
| payment | `POST /internal/payment-orders` | Có (`idempotent: true`, khóa `depositId`) | `RE.PAYMENT/API_Spec.md §2` |
| payment | `POST /internal/payment-orders/:depositId/cancel` | Có | như trên |
| payment | `GET /internal/payment-orders/:depositId` | Có | như trên |

## 3. Sự kiện

| Phát | Khi nào |
|---|---|
| `rental.deposit-created` | Bước 5 |
| `rental.deposit-expired` | `HoldExpiryJob` |
| `rental.deposit-cancelled` | Bù trừ sau khi đã tạo đơn |

| Nghe (queue `rental.payment-events`) | Xử lý |
|---|---|
| `payment.deposited` | `PENDING_PAYMENT → PAID`, đặt mốc; đích listing `DEPOSITED` |

Các sự kiện khác của payment: `RE.DEPOSIT_LIFECYCLE`.

## 4. Catalog mã lỗi (rental, phần saga)

| Mã | HTTP | Thông báo | Quy tắc | Nguồn |
|---|---|---|---|---|
| `RENTAL_DEPOSIT_IN_PROGRESS` | 409 | Có người đang đặt cọc tin này, vui lòng thử lại | BR-06 | Đề xuất |
| `RENTAL_DEPOSIT_NOT_FOUND` | 404 | Không tìm thấy đơn đặt cọc | | Đề xuất |
| `LISTING_NOT_AVAILABLE`, `LISTING_NOT_FOUND` | 409, 404 | Chuyển nguyên từ listing | BR-05 | Báo cáo |

## 5. Biến môi trường

| Biến | Mặc định | Ý nghĩa | Nguồn |
|---|---|---|---|
| `PORT` | `3003` | | |
| `DATABASE_URL`, `REDIS_URL` | | | |
| `INTERNAL_LISTING_URL`, `INTERNAL_PAYMENT_URL` | | | |
| `RABBITMQ_QUEUE` | `rental.payment-events` | | |
| `HOLD_TTL_SECONDS` | `600` | BR-07; demo rút xuống 60 | Báo cáo Bảng 5.1 |
| `DEPOSIT_LOCK_TTL_MS` | `10000` | Khóa Redis theo tin | Chốt 2026-11-16 |
| `LISTING_CALL_TIMEOUT_MS` | `2000` | `timeoutMs` cho lời gọi listing | A2 (2026-11-12) |
| `PAYMENT_CALL_TIMEOUT_MS` | `3000` `[cần đo]` | Phải để tổng ≤ 8 giây; chốt sau khi đo E1, E2 | A2 (2026-11-12) |
| `HOLD_EXPIRY_INTERVAL_MS` | `5000` | Chu kỳ `HoldExpiryJob`; E4 cần ≤ 10 giây | Chốt 2026-11-16 |
| `SAGA_RECONCILE_INTERVAL_MS`, `SAGA_STUCK_AFTER_SECONDS` | `15000`, `30` | `SagaReconcileJob`; `SAGA_RECONCILE_INTERVAL_MS=0` tắt lịch (test gọi `runOnce`) | Chốt 2026-11-16; `0` thêm 2026-11-22 |

`.env` gốc đang có `DEPOSIT_PAYMENT_TTL_SECONDS`, `RESERVATION_TTL_SECONDS`, `PAYMENT_CLAIM_TTL_SECONDS`, `ADMIN_SLA_SECONDS` của luồng cũ → bỏ, thay bằng `HOLD_TTL_SECONDS` và các biến `_SECONDS` ở `RE.DEPOSIT_LIFECYCLE §6` (A3).

## 6. DDL `rental_db` (theo Báo cáo Bảng 3.5, cột thêm theo A8)

```sql
CREATE TABLE deposits (
  id uuid PRIMARY KEY,                             -- rental sinh trước khi giữ chỗ
  listing_id uuid NOT NULL,                        -- không FK
  tenant_id uuid NOT NULL,
  owner_id uuid NOT NULL,                          -- bản chụp
  listing_title varchar(200) NOT NULL,             -- bản chụp
  amount_vnd bigint NOT NULL CHECK (amount_vnd > 0),   -- bản chụp (BR-04)
  status varchar(20) NOT NULL
    CHECK (status IN ('PENDING_PAYMENT','PAID','EXPIRED','CANCELLED','REFUND_REQUESTED',
                      'REFUNDED','RELEASED','WITHDRAWN')),   -- CANCELLED: A1
  payment_order_id uuid,
  checkout_url text, qr_code text,
  expires_at timestamptz NOT NULL,                 -- = held_until
  paid_at timestamptz,
  refund_deadline_at timestamptz,                  -- paid_at + REFUND_WINDOW_SECONDS
  auto_release_at timestamptz,                     -- paid_at + AUTO_RELEASE_SECONDS
  release_reminded_at timestamptz,                 -- ngoài Bảng 3.5 (A8)
  admin_confirmed_at timestamptz, admin_confirmed_by uuid,
  seller_acknowledged_at timestamptz,
  released_at timestamptz, release_trigger varchar(10),   -- TENANT | AUTO
  refunded_at timestamptz, withdrawn_at timestamptz,
  refund_synced_at timestamptz,                    -- A8: payment đã nhận yêu cầu hoàn (RE.DEPOSIT_LIFECYCLE)
  cancelled_reason varchar(200),
  listing_target_status varchar(20),               -- A8: trạng thái listing cần đồng bộ
  listing_synced_at timestamptz,                   -- null = chưa đồng bộ
  version int NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
-- Lớp chặn cuối: mỗi BĐS tối đa một đơn đang hoạt động (NFR01)
CREATE UNIQUE INDEX ux_deposits_active_listing ON deposits (listing_id)
  WHERE status IN ('PENDING_PAYMENT','PAID','REFUND_REQUESTED');
CREATE INDEX ix_deposits_expiry ON deposits (expires_at) WHERE status = 'PENDING_PAYMENT';
CREATE INDEX ix_deposits_auto_release ON deposits (auto_release_at) WHERE status = 'PAID';
CREATE INDEX ix_deposits_listing_sync ON deposits (updated_at) WHERE listing_synced_at IS NULL AND listing_target_status IS NOT NULL;
CREATE INDEX ix_deposits_tenant ON deposits (tenant_id, created_at DESC);
CREATE INDEX ix_deposits_owner ON deposits (owner_id, created_at DESC);

CREATE TABLE saga_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  deposit_id uuid NOT NULL REFERENCES deposits(id),
  step varchar(40) NOT NULL,       -- HOLD_LISTING, CREATE_PAYMENT_ORDER, CANCEL_PAYMENT_ORDER, RELEASE_LISTING, SYNC_LISTING
  outcome varchar(20) NOT NULL,    -- OK, BUSINESS_ERROR, NOT_EXECUTED, UNKNOWN
  detail jsonb,
  correlation_id varchar(128),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ix_saga_log_deposit ON saga_log (deposit_id, created_at);
```

`saga_log` ghi bước bắt đầu bằng `HOLD_LISTING` **sau** khi đã có `deposits` (khóa ngoại). Bước giữ chỗ chưa có đơn nếu lỗi thì chỉ log ứng dụng.

## 7. Đã chốt 2026-11-16

1. Tham số job, khóa ở §5. `PAYMENT_CALL_TIMEOUT_MS` vẫn chốt sau khi đo E1, E2 (A2).
2. Lỗi nghiệp vụ của listing (`LISTING_*`, ví dụ `LISTING_NOT_AVAILABLE`) chuyển nguyên mã cho client.

## 8. Điểm [cần xác nhận]

_Không còn điểm mở._ Mục 1 dưới đây **đã chốt 2026-11-22 (A, C20): theo đề xuất**, mở rộng cho mọi 4xx của listing (B1). Làm ở T3.3 (`ListingSyncService`).

1. ~~**[cần xác nhận]**~~ **(đã chốt)** **`409 LISTING_INVALID_STATUS` khi rental đẩy đích `AVAILABLE` (nhả chỗ, bù trừ, hết hạn).** Listing (`RE.LISTING/API_Spec.md §2.2`, v1.4) trả `200` khi tin đã `AVAILABLE`, và `409 LISTING_INVALID_STATUS` kèm `details { current, target }` khi tin đang `HELD`/`DEPOSITED`/`RENTED` thuộc đơn **khác** (chỗ đã giao cho người khác, hoặc đơn này đã mất quyền trên tin). Đề xuất cho rental: coi `409` này là **kết cục cuối**, không retry. `ListingSyncService.push` đặt `listing_synced_at = now()`, ghi `saga_log` `BUSINESS_ERROR` và log `warn` kèm `details`; job (b) không nhặt lại (hiện ghi "đẩy lại tới khi xong", test 17). Chỉ `503`/`504`/lỗi kết nối mới đẩy lại. Chưa chốt → rental sẽ lặp vô hạn trên một tin không còn thuộc đơn. Xử lý ở T3.x (C, T3.3 đồng bộ listing); **không sửa rental ở T2.3**. Sổ: `implementation/van-de-can-quyet-dinh.md` C20.
