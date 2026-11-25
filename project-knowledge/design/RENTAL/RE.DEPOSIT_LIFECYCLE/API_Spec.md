# RE.DEPOSIT_LIFECYCLE — Đặc tả API

| | |
|---|---|
| **Mã chức năng** | `RE.DEPOSIT_LIFECYCLE` — đơn sau khi `PAID`: bàn giao, nhận phòng, yêu cầu hoàn, giải ngân, điều kiện rút |
| **Service** | `rental` (cổng 3003) |
| **Quy tắc** | BR-11, BR-12, BR-13, BR-15, BR-16, BR-18, BR-19 |
| **CSDL** | `rental_db`: `deposits` (DDL ở `RE.DEPOSIT_SAGA/API_Spec.md §6`), `audit_log` |
| **Chủ sở hữu / Cập nhật / Phiên bản** | hoang.lv — 2026-11-25 — v1.2 |

> Đường dẫn chốt 2026-11-12 (A6). Thao tác lấy theo Báo cáo v2 Bảng 3.9. Hồ sơ người thuê đã cắt (`implementation/van-de-can-quyet-dinh.md` D).

## 1. API công khai

| # | Method, đường dẫn | Quyền | Chuyển | Quy tắc |
|---|---|---|---|---|
| 1 | `GET /api/v1/deposits/mine` | tenant, landlord | — | Người thuê: đơn của mình. Chủ trọ: đơn có `seller_acknowledged_at` (BR-11) và đơn `REFUNDED` của tin mình (phần còn lại, BR-15). Kèm `allowedActions` |
| 2 | `GET /api/v1/deposits/:id` | tenant chủ đơn; landlord chủ tin sau khi xác nhận bàn giao hoặc khi đơn `REFUNDED`; admin | — | BR-19 |
| 3 | `POST /api/v1/deposits/:id/confirm-move-in` | tenant | `PAID → RELEASED` | BR-13, trigger `TENANT` |
| 4 | `POST /api/v1/deposits/:id/refund-request` | tenant, `Idempotency-Key` | `PAID → REFUND_REQUESTED` | BR-12 |
| 5 | `GET /api/v1/admin/deposits` | admin | — | Lọc `status`, mặc định `PAID` chưa bàn giao |
| 6 | `POST /api/v1/admin/deposits/:id/hand-over` | admin | mốc `admin_confirmed_at`; ghi `audit_log` | BR-11 |
| 7 | `POST /api/v1/deposits/:id/acknowledge` | landlord chủ tin | mốc `seller_acknowledged_at` | BR-11 |

### Thứ tự kiểm tra

| Route | # | Điều kiện | Kết quả |
|---|---|---|---|
| Mọi route có `:id` | 1 | Không có | `404 RENTAL_DEPOSIT_NOT_FOUND` |
| | 2 | Không phải người được phép (BR-19) | `403 FORBIDDEN` |
| 3 | 3 | `status ≠ PAID` | `409 RENTAL_INVALID_TRANSITION` |
| 4 | 3 | `status ≠ PAID` (đã nhận phòng, đã có yêu cầu) | `409 RENTAL_INVALID_TRANSITION` (Báo cáo T11) |
| 4 | 4 | `now() > refund_deadline_at` | `409 RENTAL_REFUND_WINDOW_CLOSED` (Báo cáo T11) |
| 6 | 3 | `status = REFUND_REQUESTED` | `409 RENTAL_REFUND_PENDING` |
| 6 | 4 | `status ∉ {PAID, RELEASED}` (đơn đã tự giải ngân vẫn bàn giao được: chỉ ghi `admin_confirmed_at`, giữ `RELEASED`) | `409 RENTAL_INVALID_TRANSITION` |
| 6 | 5 | Đã bàn giao | `200`, không đổi (idempotent) |
| 7 | 3 | `admin_confirmed_at IS NULL` | `409 RENTAL_NOT_HANDED_OVER` |
| 7 | 4 | Đã xác nhận | `200`, không đổi |

Mọi chuyển là `UPDATE ... WHERE status = <từ>` (BR-18); 0 dòng sau khi qua kiểm tra → đọc lại, trả `409`.

### Chốt khi làm T3.5 (2026-11-25, A duyệt)

- **Ai xem được đơn (route 2, BR-19):** người thuê chủ đơn; chủ tin khi quản trị viên **đã bàn giao** (`admin_confirmed_at`) hoặc đơn `REFUNDED` — chủ trọ cần mở đơn để xác nhận (route 7); admin. Còn lại `403`. **Danh sách** của chủ trọ (route 1) chỉ có đơn đã xác nhận (`seller_acknowledged_at`) hoặc `REFUNDED` (BR-11).
- **`allowedActions`:** `CONFIRM_MOVE_IN` (người thuê, `PAID`), `REQUEST_REFUND` (người thuê, `PAID`, `now() <= refund_deadline_at`), `ACKNOWLEDGE` (chủ tin, đã bàn giao, chưa xác nhận), `HAND_OVER` (admin, `PAID`/`RELEASED`, chưa bàn giao).
- **Đơn trả về (`DepositDto`):** `id, listingId, listingTitle, tenantId, ownerId, amountVnd, status, paidAt, refundDeadlineAt, autoReleaseAt, adminConfirmedAt, sellerAcknowledgedAt, releasedAt, releaseTrigger, refundedAt, withdrawnAt, createdAt, allowedActions`; `checkoutUrl, qrCode, expiresAt` chỉ khi người gọi là người thuê và đơn `PENDING_PAYMENT`.
- **Route 1, 5:** phân trang `page/pageSize` (`api-convention §4`), `ORDER BY created_at DESC, id DESC`; lọc `status` tùy chọn. Route 5 không truyền `status` → `PAID` chưa bàn giao.
- **Route 4 gửi payment lỗi** (mọi loại, kể cả 4xx): đơn vẫn `REFUND_REQUESTED`, trả `200`; `SagaReconcileJob` (c) gửi lại mỗi lượt tới khi thành công (`refund_synced_at`), log `warn`. Không có kết cục cuối: yêu cầu hoàn phải tới quản trị viên (BR-12).
- **Đồng bộ tin:** route 3 và `AutoReleaseJob` đẩy `RENTED` ngay sau commit (lỗi → `SagaReconcileJob` (b)); `payment.refunded` chỉ đặt đích `AVAILABLE`, job (b) đẩy (handler không gọi HTTP).
- **Sự kiện đến khi đơn không ở trạng thái chờ:** `UPDATE` 0 dòng → bỏ qua, log `warn`; `payment.refunded` `SYSTEM` → bỏ qua, log `info`; `withdrawal-completed` cho đơn `REFUNDED` → chỉ đặt `withdrawn_at` nếu còn trống.

## 2. API nội bộ

Viết lại `contracts/openapi/rental-internal.v1.yaml` ở T0.3 (A7; file hiện mô tả `GET /internal/reservations/{id}` của luồng cũ).

| Method, đường dẫn | Bên gọi | Kết quả |
|---|---|---|
| `GET /internal/deposits/:id/withdrawal-eligibility` | payment (S4) | `200 { depositId, ownerId, amountVnd, status, eligible, missing[] }`; `404 RENTAL_DEPOSIT_NOT_FOUND` |

BR-15 (sửa 2026-11-12):

| `status` | `eligible` khi | `missing` có thể có |
|---|---|---|
| `RELEASED` | Đủ hai mốc bàn giao và xác nhận | `NOT_HANDED_OVER`, `NOT_ACKNOWLEDGED` |
| `REFUNDED` | Luôn (phần còn lại sau hoàn 70%), không cần hai mốc | — |
| Khác | Không | `NOT_RELEASED` |

`amountVnd` là tiền cọc của đơn (bản chụp). Payment tự tính số được rút (`RE.PAYOUT §1`) và tự kiểm "không có lệnh rút hay hoàn đang mở, mỗi đơn một lệnh rút".

## 3. Lời gọi ra ngoài

| Tới | Lệnh | Khi nào | Retry |
|---|---|---|---|
| payment | `POST /internal/refund-requests` `{ depositId }` | Sau commit route 4; job thử lại | Có (`idempotent: true`) |
| listing | `PUT /internal/listings/:id/status` | `RENTED` sau `RELEASED`; `AVAILABLE` sau `REFUNDED` | Có |

## 4. Sự kiện

| Phát | Khi nào |
|---|---|
| `rental.deposit-handed-over` (AdminConfirmedToSeller) | Route 6 |
| `rental.deposit-released` | Route 3 (`TENANT`) hoặc `AutoReleaseJob` (`AUTO`) |
| `rental.release-reminder` | `DeadlineJob`, trước `auto_release_at` 24 giờ |

| Nghe | Xử lý |
|---|---|
| `payment.refunded`, `requesterType = TENANT` | `REFUND_REQUESTED → REFUNDED`, đích listing `AVAILABLE` |
| `payment.refunded`, `requesterType = SYSTEM` | Không đổi (tiền đến muộn, đơn `EXPIRED`) |
| `payment.refund-rejected` | `REFUND_REQUESTED → PAID` |
| `payment.withdrawal-completed` | `RELEASED → WITHDRAWN`. Đơn `REFUNDED`: chỉ ghi `withdrawn_at`, giữ `REFUNDED` |
| `payment.withdrawal-requested`, `payment.withdrawal-failed` | Rental **không** nghe (chốt 2026-11-16, C10); chỉ notification nghe. Queue `rental.payment-events` không bind hai khóa này |

## 5. Catalog mã lỗi (rental, phần vòng đời)

| Mã | HTTP | Thông báo | Quy tắc | Nguồn |
|---|---|---|---|---|
| `RENTAL_INVALID_TRANSITION` | 409 | Không thể thực hiện ở trạng thái hiện tại của đơn | BR-18 | Đề xuất |
| `RENTAL_REFUND_WINDOW_CLOSED` | 409 | Đã quá 48 giờ kể từ lúc thanh toán, không thể yêu cầu hoàn | BR-12 | Đề xuất |
| `RENTAL_REFUND_PENDING` | 409 | Đơn đang có yêu cầu hoàn tiền | BR-11 | Đề xuất |
| `RENTAL_NOT_HANDED_OVER` | 409 | Quản trị viên chưa bàn giao đơn | BR-11 | Đề xuất |

## 6. Biến môi trường

| Biến | Mặc định | Nguồn |
|---|---|---|
| `REFUND_WINDOW_SECONDS` | `172800` (48 giờ) | Báo cáo Bảng 5.1, đổi đơn vị theo A3 |
| `AUTO_RELEASE_SECONDS` | `259200` (72 giờ) | Báo cáo Bảng 5.1, đổi đơn vị theo A3 |
| `RELEASE_REMINDER_SECONDS` | `86400` (24 giờ) | Báo cáo Bảng 5.1, đổi đơn vị theo A3 |
| `AUTO_RELEASE_INTERVAL_MS`, `DEADLINE_INTERVAL_MS` | `10000`, `10000`; `0` tắt lịch (test gọi `runOnce`) | Chốt 2026-11-16; `0` thêm 2026-11-25 |

Demo rút ngắn xuống vài chục giây. Báo cáo cuối kỳ sửa tên biến ở Bảng 5.1.

## 7. DDL bổ sung

```sql
-- B12: nhật ký thao tác quản trị viên trên đơn, ghi cùng transaction với thay đổi
CREATE TABLE audit_log (
  id bigserial PRIMARY KEY,
  actor_id uuid NOT NULL,
  action varchar(50) NOT NULL,                  -- HAND_OVER
  target_type varchar(30) NOT NULL,             -- DEPOSIT
  target_id uuid NOT NULL,
  before jsonb, after jsonb,
  correlation_id varchar(128),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ix_audit_log_target ON audit_log (target_type, target_id, created_at);
```

Cùng khuôn với `audit_log` của payment (`RE.PAYOUT/API_Spec.md`). Lần bàn giao lặp lại (idempotent, `200` không đổi) không ghi thêm dòng. Nội dung (T3.5): `action='HAND_OVER'`, `target_type='DEPOSIT'`, `before {status, adminConfirmedAt: null}`, `after {status, adminConfirmedAt, adminConfirmedBy}`, `correlation_id` của request.

Index thêm (T3.5, `non-functional-standards §1`):

```sql
CREATE INDEX ix_deposits_status_created ON deposits (status, created_at DESC);            -- route 5 lọc theo trạng thái
CREATE INDEX ix_deposits_refund_sync ON deposits (updated_at)
  WHERE status = 'REFUND_REQUESTED' AND refund_synced_at IS NULL;                          -- SagaReconcileJob (c)
```

## 8. Đã chốt 2026-11-16

1. Bàn giao được khi đơn đã `RELEASED`: chỉ ghi mốc, không đổi trạng thái.
2. Rental không nghe `payment.withdrawal-requested`, `payment.withdrawal-failed`.
