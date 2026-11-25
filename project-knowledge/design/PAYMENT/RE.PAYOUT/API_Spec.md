# RE.PAYOUT — Đặc tả API

| | |
|---|---|
| **Mã chức năng** | `RE.PAYOUT` — ví trung gian, yêu cầu hoàn, lệnh rút, chứng từ, nhật ký quản trị |
| **Service** | `payment` (cổng 3004) |
| **Quy tắc** | BR-10, BR-12, BR-15, BR-16, BR-17, BR-19 |
| **Quyết định** | ADR-0009 |
| **CSDL** | `payment_db`: `admin_wallet`, `wallet_transactions`, `refund_requests`, `withdrawal_requests`, `transfer_receipts`, `audit_log`; S3 bucket `payment-proofs`. `Idempotency-Key` lưu Redis bằng `@Idempotent()` của template, không có bảng `idempotency_keys` (B11) |
| **Chủ sở hữu / Cập nhật / Phiên bản** | hoang.lv — 2026-11-25 — v1.3 |

> Thao tác theo Báo cáo v2 Bảng 3.10. Đường dẫn chốt 2026-11-12 (A6).

## 1. API công khai

| # | Method, đường dẫn | Quyền | Thao tác |
|---|---|---|---|
| 1 | `GET /api/v1/payments/transactions/mine` | user | Giao dịch ví liên quan người gọi (BR-19) |
| 2 | `POST /api/v1/withdrawals` | landlord, `Idempotency-Key` | Tạo lệnh rút `PENDING` |
| 3 | `GET /api/v1/withdrawals/mine` | landlord | Lệnh rút của tôi |
| 4 | `GET /api/v1/admin/withdrawals?status=` | admin | Lệnh rút đang chờ |
| 5 | `GET /api/v1/admin/refund-requests?status=` | admin | Yêu cầu hoàn đang chờ |
| 6 | `POST /api/v1/admin/withdrawals/:id/complete` | admin, `Idempotency-Key`, multipart `receipt` | `COMPLETED`, `WITHDRAW_OUT` |
| 7 | `POST /api/v1/admin/withdrawals/:id/fail` | admin, body `{ reason }` | `FAILED`, ví không đổi |
| 8 | `POST /api/v1/admin/refund-requests/:id/complete` | admin, `Idempotency-Key`, multipart `receipt` | `COMPLETED`, `REFUND_OUT` |
| 9 | `POST /api/v1/admin/refund-requests/:id/reject` | admin, body `{ reason }` | `REJECTED`, đơn về `PAID` |
| 10 | `POST /api/v1/admin/refund-requests/:id/fail` | admin, body `{ reason }` | `FAILED`, đơn giữ `REFUND_REQUESTED` |
| 11 | `GET /api/v1/admin/wallet` | admin | `{ balanceVnd, pendingWithdrawalVnd, pendingRefundVnd }` |
| 12 | `GET /api/v1/admin/audit-logs` | admin | Nhật ký thao tác, phân trang |
| 13 | `GET /api/v1/admin/withdrawals/:id` | admin | Chi tiết lệnh rút kèm `bankAccount` đầy đủ (§1.5) |
| 14 | `GET /api/v1/admin/refund-requests/:id` | admin | Chi tiết yêu cầu hoàn kèm `bankAccount` đầy đủ (§1.5) |

### 1.1 Tạo lệnh rút (route 2) — BR-15

Body: `{ depositId }`. Số tiền do payment tính, không nhận từ client (BR-15 sửa 2026-11-12):

| `status` từ rental | Số tiền rút |
|---|---|
| `RELEASED` | `amountVnd` |
| `REFUNDED` | `amountVnd` − tổng `amount_vnd` các yêu cầu hoàn `TENANT` `COMPLETED` của đơn (phần 30% thuộc chủ trọ, BR-12) |

Kết quả bằng 0 → `409 PAYMENT_WITHDRAWAL_NOT_ELIGIBLE`.

| # | Điều kiện | Kết quả |
|---|---|---|
| 1 | `RentalClient.withdrawalEligibility(depositId)` `404` | `404 RENTAL_DEPOSIT_NOT_FOUND` |
| 2 | `ownerId ≠ sub` | `403 FORBIDDEN` |
| 3 | `eligible = false` | `409 PAYMENT_WITHDRAWAL_NOT_ELIGIBLE`, `details.missing` (Báo cáo T13) |
| 4 | Có lệnh rút `PENDING`/`COMPLETED` hoặc yêu cầu hoàn `PENDING_ADMIN`/`FAILED` cho đơn | `409 PAYMENT_PAYOUT_ALREADY_OPEN` (BR-15, BR-16) |
| 5 | `IdentityClient.getBankAccount(sub)` `404` | `409 PAYMENT_BANK_ACCOUNT_MISSING` |
| 6 | Rental hoặc identity lỗi | `503`/`504` |
| 7 | Hợp lệ | Transaction: `INSERT withdrawal_requests PENDING` (bản chụp ngân hàng đã che: `bankName`, `accountHolder`, `accountLast4`) + outbox `payment.withdrawal-requested` → `201` |
| 8 | Hai lệnh cùng lúc lọt qua bước 4 | `ux_withdrawal_active` chặn → bắt `23505` → `409 PAYMENT_PAYOUT_ALREADY_OPEN` |

### 1.2 Hoàn tất lệnh chi (route 6, 8) — BR-17

| # | Điều kiện | Kết quả |
|---|---|---|
| 1 | Không có | `404 PAYMENT_PAYOUT_NOT_FOUND` |
| 2 | Không phải `PENDING` (rút) / `PENDING_ADMIN` hoặc `FAILED` (hoàn) | `409 PAYMENT_PAYOUT_INVALID_STATUS` |
| 3 | Thiếu tệp, quá `RECEIPT_MAX_BYTES`, loại khai báo ngoài {`image/jpeg`, `image/png`, `application/pdf`}, hoặc byte đầu tệp không khớp loại khai báo (chặn đổi đuôi) | `400 PAYMENT_RECEIPT_INVALID` |
| 4 | `sha256` đã có trong `transfer_receipts` | `409 PAYMENT_RECEIPT_ALREADY_USED` (Báo cáo T14) |
| 5 | Số dư ví < số tiền | `409 PAYMENT_WALLET_INSUFFICIENT`, log `error` (không được xảy ra nếu bất biến đúng) |
| 6 | Hợp lệ | Lưu tệp S3 trước (khóa `receipts/<sha256>.<đuôi>`; S3 lỗi → `503 DEPENDENCY_UNAVAILABLE`, chưa ghi DB); transaction: `transfer_receipts`, `UPDATE ... WHERE status=<từ>` → `COMPLETED`, `wallet_transactions` `WITHDRAW_OUT`/`REFUND_OUT`, `balance -= amount`, `audit_log`, outbox `payment.withdrawal-completed` / `payment.refunded` → `200` |

Hai quản trị viên cùng hoàn tất: bên thua `UPDATE` 0 dòng → `409 PAYMENT_PAYOUT_INVALID_STATUS`, cả transaction (kể cả dòng `transfer_receipts`) rollback → ví trừ một lần. Vi phạm `CHECK (balance_vnd >= 0)` → `409 PAYMENT_WALLET_INSUFFICIENT` + log `error`. Hoàn tất yêu cầu hoàn `SYSTEM` cũng phát `payment.refunded` (`requesterType: SYSTEM`; rental bỏ qua).

Yêu cầu hoàn `FAILED` được hoàn tất lại (Báo cáo: "đơn giữ `REFUND_REQUESTED` để xử lý lại"). Lệnh rút `FAILED` thì chủ trọ tạo lệnh mới sau khi sửa ngân hàng.

### 1.3 Từ chối, thất bại (route 7, 9, 10)

`reason` bắt buộc, cắt khoảng trắng hai đầu, 1–500 ký tự (khớp `varchar(500)`); sai → `400 VALIDATION_FAILED`. `UPDATE ... WHERE status=<từ> RETURNING` (0 dòng: không có → `404`, có → `409 PAYMENT_PAYOUT_INVALID_STATUS`). Trạng thái `<từ>`: lệnh rút thất bại từ `PENDING`; yêu cầu hoàn từ chối từ `PENDING_ADMIN` hoặc `FAILED`, thất bại từ `PENDING_ADMIN` + `audit_log` + outbox (`payment.withdrawal-failed`, `payment.refund-rejected`; yêu cầu hoàn `FAILED` không phát sự kiện).

`audit_log`: `action` ∈ `COMPLETE_WITHDRAWAL`, `FAIL_WITHDRAWAL`, `COMPLETE_REFUND`, `REJECT_REFUND`, `FAIL_REFUND`; `target_type` `WITHDRAWAL` / `REFUND`; `before`, `after` = `{ status, … }`; ghi cùng transaction với thao tác.

### 1.4 Truy vấn (route 1, 3, 4, 5, 11, 12)

| Route | Kết quả |
|---|---|
| 1 | `wallet_transactions` có `tenant_id = sub` **hoặc** `owner_id = sub` (BR-19); `{ id, type, amountVnd, depositId, createdAt }`; phân trang `created_at DESC, id DESC` |
| 3 | Lệnh rút có `owner_id = sub`, mới nhất trước, phân trang |
| 4, 5 | Lọc `status` tùy chọn, mới nhất trước, phân trang; **không** gọi identity (cấm gọi service trong vòng lặp) |
| 11 | Một truy vấn: số dư + tổng lệnh rút `PENDING` + tổng yêu cầu hoàn `PENDING_ADMIN`/`FAILED` |
| 12 | Phân trang, lọc `targetType`, `targetId` tùy chọn, mới nhất trước |

### 1.5 Chi tiết cho quản trị viên (route 13, 14) — chốt 2026-11-25

Trả chi tiết lệnh kèm `bankAccount: { bankName, accountHolder, accountNumber }` của người nhận (chủ trọ với lệnh rút, người thuê với yêu cầu hoàn), lấy từ `IdentityClient.getBankAccount` **ngay lúc xem**: payment không lưu, không log số đầy đủ. Identity `404` → `bankAccount: null` (người nhận chưa khai; tiền đến muộn thường rơi vào đây: người thuê nhắn quản trị viên qua chat `SUPPORT`). Identity `503`/`504` → chuyển nguyên. Không có lệnh → `404 PAYMENT_PAYOUT_NOT_FOUND`.

## 2. API nội bộ

| Method, đường dẫn | Bên gọi | Kết quả |
|---|---|---|
| `POST /internal/refund-requests` | rental | Body `{ depositId }`. Tạo yêu cầu hoàn 70% `PENDING_ADMIN` (`requester_type = TENANT`) → `201` |

| Điều kiện | Kết quả |
|---|---|
| Không có order cho đơn | `404 PAYMENT_ORDER_NOT_FOUND` |
| Order chưa `PAID` | `409 PAYMENT_ORDER_NOT_PAID` |
| Đã có yêu cầu `TENANT` `PENDING_ADMIN`/`FAILED`/`COMPLETED` | `200`, trả yêu cầu đó (idempotent) |
| Chỉ có yêu cầu cũ `REJECTED` (người thuê xin lại trong 48 giờ) | Tạo mới → `201` |
| Hai lời gọi cùng lúc | `ux_refund_tenant_active` → `23505` → đọc lại → `200` |

Số tiền hoàn = `floor(amount_vnd × 70 / 100)` VND của payment order; tỉ lệ `70` là hằng số trong `domain/refund-amount.ts` (Báo cáo cố định). `tenantId` lấy từ `payment_orders`.

## 3. Lời gọi ra ngoài

| Tới | Lệnh | Retry |
|---|---|---|
| rental (S4) | `GET /internal/deposits/:id/withdrawal-eligibility` | Có |
| identity (S3) | `GET /internal/users/:id/bank-account` | Có |

## 4. Sự kiện phát

| Sự kiện | Khi nào |
|---|---|
| `payment.withdrawal-requested` | Route 2 |
| `payment.withdrawal-completed` | Route 6 |
| `payment.withdrawal-failed` | Route 7 |
| `payment.refunded` (DepositRefunded, kèm `requesterType`) | Route 8, cả yêu cầu `TENANT` lẫn `SYSTEM` |
| `payment.refund-rejected` | Route 9 |

Route 10 (hoàn `FAILED`) không phát sự kiện.

## 5. Catalog mã lỗi

| Mã | HTTP | Thông báo | Quy tắc | Nguồn |
|---|---|---|---|---|
| `PAYMENT_WITHDRAWAL_NOT_ELIGIBLE` | 409 | Đơn chưa đủ điều kiện rút tiền | BR-15 | Đề xuất |
| `PAYMENT_PAYOUT_ALREADY_OPEN` | 409 | Đơn đã có lệnh rút hoặc yêu cầu hoàn | BR-15, BR-16 | Đề xuất |
| `PAYMENT_BANK_ACCOUNT_MISSING` | 409 | Vui lòng khai tài khoản nhận tiền | | Đề xuất |
| `PAYMENT_PAYOUT_NOT_FOUND` | 404 | Không tìm thấy lệnh chi | | Đề xuất |
| `PAYMENT_PAYOUT_INVALID_STATUS` | 409 | Lệnh chi không ở trạng thái xử lý được | | Đề xuất |
| `PAYMENT_RECEIPT_INVALID` | 400 | Chứng từ không hợp lệ | BR-17 | Đề xuất |
| `PAYMENT_RECEIPT_ALREADY_USED` | 409 | Chứng từ đã được dùng cho lệnh khác | BR-17 | Đề xuất |
| `PAYMENT_WALLET_INSUFFICIENT` | 409 | Số dư ví trung gian không đủ | NFR01 | Đề xuất |
| `PAYMENT_ORDER_NOT_PAID` | 409 | Đơn chưa được thanh toán | | Đề xuất |

## 6. Biến môi trường

| Biến | Mặc định | Ý nghĩa |
|---|---|---|
| `INTERNAL_RENTAL_URL`, `INTERNAL_IDENTITY_URL` | (bắt buộc) | Gọi rental, identity |
| `REDIS_URL` | (bắt buộc) | `Idempotency-Key` route 2, 6, 8 |
| `S3_*`, `S3_BUCKETS` | (bắt buộc), `payment-proofs` | Chứng từ |
| `RECEIPT_MAX_BYTES` | `5242880` (5 MB) | Chứng từ tải multipart qua payment; loại `image/jpeg`, `image/png`, `application/pdf` |

## 7. DDL (đề xuất theo Báo cáo Bảng 3.5)

```sql
CREATE TABLE admin_wallet (
  id smallint PRIMARY KEY DEFAULT 1 CHECK (id = 1),     -- một ví
  balance_vnd bigint NOT NULL DEFAULT 0 CHECK (balance_vnd >= 0),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE wallet_transactions (                       -- chỉ thêm, không sửa, không xóa
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  type varchar(20) NOT NULL CHECK (type IN ('DEPOSIT_IN','LATE_PAYMENT_IN','WITHDRAW_OUT','REFUND_OUT')),
  amount_vnd bigint NOT NULL CHECK (amount_vnd > 0),
  deposit_id uuid,
  ref_type varchar(20) NOT NULL,                          -- ORDER, LATE_PAYMENT, WITHDRAWAL, REFUND
  ref_id uuid NOT NULL,
  tenant_id uuid, owner_id uuid,                          -- A8, phục vụ route 1
  correlation_id varchar(128),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (ref_type, ref_id)                               -- một tham chiếu một dòng
);
CREATE INDEX ix_wallet_tx_tenant ON wallet_transactions (tenant_id, created_at DESC);
CREATE INDEX ix_wallet_tx_owner ON wallet_transactions (owner_id, created_at DESC);

CREATE TABLE refund_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  deposit_id uuid NOT NULL,
  tenant_id uuid NOT NULL,
  requester_type varchar(10) NOT NULL CHECK (requester_type IN ('TENANT','SYSTEM')),
  amount_vnd bigint NOT NULL CHECK (amount_vnd > 0),
  status varchar(20) NOT NULL DEFAULT 'PENDING_ADMIN'
    CHECK (status IN ('PENDING_ADMIN','COMPLETED','REJECTED','FAILED')),
  reason varchar(500),
  receipt_id uuid,
  processed_by uuid, processed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
-- Một yêu cầu hoàn của người thuê đang mở hoặc đã xong mỗi đơn
CREATE UNIQUE INDEX ux_refund_tenant_active ON refund_requests (deposit_id)
  WHERE requester_type = 'TENANT' AND status IN ('PENDING_ADMIN','FAILED','COMPLETED');
-- Route 5: lọc status (tùy chọn), sắp created_at DESC, id DESC
CREATE INDEX ix_refund_status_created ON refund_requests (status, created_at DESC, id DESC);
CREATE INDEX ix_refund_created ON refund_requests (created_at DESC, id DESC);

CREATE TABLE withdrawal_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  deposit_id uuid NOT NULL,
  owner_id uuid NOT NULL,
  amount_vnd bigint NOT NULL CHECK (amount_vnd > 0),
  bank_snapshot jsonb NOT NULL,                           -- tên ngân hàng, chủ tài khoản, bốn số cuối
  status varchar(20) NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING','COMPLETED','FAILED')),
  reason varchar(500),
  receipt_id uuid,
  processed_by uuid, processed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
-- Mỗi đơn chỉ rút một lần (BR-16)
CREATE UNIQUE INDEX ux_withdrawal_active ON withdrawal_requests (deposit_id) WHERE status IN ('PENDING','COMPLETED');
-- Route 3 (owner_id), route 4 (status tùy chọn); cùng sắp created_at DESC, id DESC
CREATE INDEX ix_withdrawal_owner_created ON withdrawal_requests (owner_id, created_at DESC, id DESC);
CREATE INDEX ix_withdrawal_status_created ON withdrawal_requests (status, created_at DESC, id DESC);
CREATE INDEX ix_withdrawal_created ON withdrawal_requests (created_at DESC, id DESC);

CREATE TABLE transfer_receipts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  sha256 char(64) NOT NULL UNIQUE,                        -- BR-17
  object_key varchar(300) NOT NULL,
  uploaded_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE audit_log (
  id bigserial PRIMARY KEY,
  actor_id uuid NOT NULL,
  action varchar(50) NOT NULL,                            -- COMPLETE_WITHDRAWAL, FAIL_WITHDRAWAL, COMPLETE_REFUND, ...
  target_type varchar(30) NOT NULL, target_id uuid NOT NULL,
  before jsonb, after jsonb,
  correlation_id varchar(128),
  created_at timestamptz NOT NULL DEFAULT now()
);
-- Route 12: lọc target_id (chọn lọc cao); chỉ lọc target_type hoặc không lọc → quét theo thứ tự created_at
CREATE INDEX ix_audit_target_created ON audit_log (target_id, created_at DESC, id DESC);
CREATE INDEX ix_audit_created ON audit_log (created_at DESC, id DESC);
```

Các index danh sách route 3, 4, 5, 12 thêm ở migration riêng của T3.6 (bảng đã tạo ở T3.1), theo `standards/non-functional-standards.md` §Index.

## 8. Đã chốt 2026-11-16

1. Tiền hoàn `floor(amount × 70 / 100)` VND, tỉ lệ là hằng số.
2. Chứng từ tải multipart qua payment (server tính `sha256`, kiểm loại và kích thước) rồi lưu S3 `payment-proofs`.
3. Yêu cầu hoàn `FAILED` không phát sự kiện.
4. `tenantId` lấy từ `payment_orders`, rental không cần gửi.

## 8a. Đã chốt 2026-11-25 (T3.6, A duyệt)

1. Khai tài khoản nhận tiền ở trang hồ sơ (`RE.IDENTITY` route 6, 7), không ở form đăng ký; tiền đến muộn → người thuê nhắn quản trị viên qua chat `SUPPORT`. Quản trị viên xem số đầy đủ ở route 13, 14 (§1.5). Đóng §9.1.
2. Biến môi trường §6 bắt buộc khi khởi động.
3. Kiểm chứng từ theo byte đầu tệp (§1.2 dòng 3).
4. Chống đua: unique index + `UPDATE ... WHERE status` (§1.1 dòng 8, §1.2).
5. API nội bộ: yêu cầu cũ `REJECTED` → tạo mới (§2).
6. Truy vấn route 1, 11, 12 (§1.4); `audit_log`, `reason` (§1.3).

## 9. Điểm `[cần xác nhận]`

Không còn.

~~1. **Quản trị viên xem tài khoản của người thuê khi hoàn** (ghi 2026-11-18, từ T2.1). Đề xuất: màn hình yêu cầu hoàn gọi `GET /internal/users/:tenantId/bank-account` (identity trả số đầy đủ, payment không lưu). Nếu người thuê chưa khai (ví dụ tiền đến muộn): hỏi qua chat `SUPPORT`. Giao diện hiện form khai khi người dùng gửi yêu cầu hoàn lần đầu (`RE.IDENTITY/API_Spec.md §1.4`). Chốt thiết kế chi tiết ở T3.6; không làm trong T2.1.~~ (đóng 2026-11-25, xem §8a.1)
