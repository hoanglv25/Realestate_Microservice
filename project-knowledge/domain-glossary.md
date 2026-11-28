# Thuật ngữ Real-estate

> Ngôn ngữ chung của dự án. Code, tài liệu và báo cáo dùng đúng các từ này.

| | |
|---|---|
| **Chủ sở hữu / Cập nhật** | hoang.lv — 2026-11-16 |

## Viết tắt

| Từ | Nghĩa |
|---|---|
| RE | Real-estate, tiền tố mã chức năng và tên tài liệu |
| A, B, C | Ba thành viên: A Lưu Việt Hoàng, B Đỗ Trung Thành, C Đỗ Trung Thông (`implementation/README.md §2`) |
| hoang.lv | Lưu Việt Hoàng (A), chủ sở hữu tài liệu trong `project-knowledge/` |
| OTP | One-Time Password, mã xác minh dùng một lần |
| SMTP | Giao thức gửi email; dev gửi thật qua Gmail App Password (C27) |
| BĐS | Bất động sản: nhà, căn hộ, phòng do chủ trọ đăng |
| payOS | Cổng thanh toán: tạo link, VietQR, gửi webhook |
| DLQ | Dead letter queue, hàng đợi chứa thông điệp xử lý thất bại |
| DoD | Definition of Done |
| ADR | Architecture Decision Record |
| FR, NFR, US, UC | Mã yêu cầu chức năng, phi chức năng, user story, use case trong báo cáo |
| SLA | Thời hạn xử lý cam kết |

## Vai trò

| Giá trị | Nghĩa |
|---|---|
| `TENANT` | Người thuê |
| `LANDLORD` | Chủ trọ. Tên lấy từ Báo cáo có tiền tố `seller` (`seller_acknowledged_at`, `AdminConfirmedToSeller`) cũng chỉ chủ trọ |
| `ADMIN` | Quản trị viên, tạo bằng script seed |

## Từ chuẩn

Một khái niệm một cách gọi. Nhóm chốt 2026-11-12.

| Khái niệm | Viết trong văn | Viết trong code, dữ liệu | Không dùng |
|---|---|---|---|
| Thứ chủ trọ đăng | **sản phẩm** khi chủ trọ quản lý (thêm, sửa, ẩn, xóa); **tin đăng** khi hiển thị, tìm kiếm; **bất động sản (BĐS)** khi nói trạng thái `AVAILABLE`, `HELD`… (Báo cáo v2, phần thuật ngữ) | `listing`, `listings`, `listingId` | listing trong văn tiếng Việt |
| Chủ trọ | chủ trọ | vai trò `LANDLORD`; trường `ownerId` / `owner_id`; giữ `seller_*` chỉ ở tên đã có trong Báo cáo | chủ nhà, người cho thuê, seller trong văn |
| Người thuê | người thuê | `TENANT`, `tenantId` / `tenant_id` | khách thuê |
| Đơn đặt cọc | **đơn đặt cọc** ở lần đầu trong file, sau đó "đơn" | `deposit`, `deposits`, `depositId` | đơn cọc |
| Quản trị viên | quản trị viên | `ADMIN`, route `admin` | admin trong văn |
| Sự kiện | tên PascalCase, ví dụ `DepositPaid` | routing key, ví dụ `payment.deposited`; bảng đối chiếu ở `design/SHARED/RE.MESSAGING/API_Spec.md §3` | trộn hai dạng trong một câu |
| Mã truy vết | `X-Request-ID` (header) | `correlationId` (log, sự kiện) | request id |

**Chính tả:** dấu thanh đặt theo kiểu Báo cáo v2: hủy, xóa, khóa, hòa, tùy, thủy (không viết huỷ, xoá, khoá, hoà, tuỳ, thuỷ).

## Thực thể nghiệp vụ

| Thuật ngữ | Bảng | Service | Định nghĩa |
|---|---|---|---|
| Người dùng | `users` | identity | Tài khoản. Mỗi email một tài khoản, mỗi tài khoản một vai trò (`users.role`, B9). Trạng thái `PENDING_VERIFICATION` (chưa nhập OTP), `ACTIVE`, `LOCKED` (quản trị viên khóa) |
| Liên kết đăng nhập ngoài | `user_identities` | identity | Liên kết Google (đăng nhập bằng ID token, B10) |
| Tài khoản nhận tiền | `bank_accounts` | identity | Số tài khoản mã hóa, hiển thị bốn số cuối |
| Sản phẩm / tin đăng | `listings` | listing | Một BĐS do chủ trọ đăng. Sản phẩm và tin đăng là cùng một bản ghi (ADR-0010) |
| Ảnh tin | `listing_images` | listing | Key ảnh trên S3 |
| Lịch xem | `viewings` | rental | Yêu cầu xem một tin của người thuê. Không lưu giờ hẹn: hai bên chốt giờ trong chat. Mỗi tin là một căn/phòng duy nhất |
| Đơn đặt cọc | `deposits` | rental | Một lần đặt cọc, giữ bản chụp tiền cọc, tiêu đề, chủ trọ và mọi mốc thời gian |
| Nhật ký saga | `saga_log` | rental | Từng bước saga của một đơn, dùng để đối soát |
| Nhật ký thao tác | `audit_log` | rental, payment | Mỗi thao tác quản trị viên một dòng (bàn giao ở rental; hoàn tất, từ chối lệnh chi ở payment) |
| Payment order | `payment_orders` | payment | Lệnh thu tiền payOS, một-một với đơn đặt cọc |
| Webhook payOS | `payos_webhook_events` | payment | Bản sao nguyên văn mọi webhook |
| Tiền đến muộn | `late_payments` | payment | Tiền về sau khi đơn `EXPIRED` |
| Yêu cầu hoàn | `refund_requests` | payment | Lệnh chi về người thuê; người yêu cầu `TENANT` hoặc `SYSTEM` |
| Lệnh rút | `withdrawal_requests` | payment | Lệnh chi về chủ trọ |
| Chứng từ | `transfer_receipts` | payment | Ảnh chuyển khoản của quản trị viên, `sha256` duy nhất |
| Ví trung gian | `admin_wallet` | payment | Số dư tiền cọc nền tảng đang giữ |
| Giao dịch ví | `wallet_transactions` | payment | Mỗi biến động số dư một dòng |
| Thông báo | `notifications` | notification | Tin trong ứng dụng, nội dung linh hoạt ở `jsonb` |
| Hội thoại, tin nhắn | `conversations`, `messages` | notification | Nhắn tin người thuê – chủ trọ, kênh hỗ trợ với quản trị viên |

## Trạng thái đơn đặt cọc

| Trạng thái | Nghĩa | Ai đặt |
|---|---|---|
| `PENDING_PAYMENT` | Đơn đã tạo, BĐS đang giữ, chờ tiền | rental khi giữ chỗ được |
| `PAID` | Tiền đã vào ví trung gian, chưa giải ngân | rental khi nhận `DepositPaid` (`payment.deposited`) |
| `EXPIRED` | Hết 10 phút chưa có tiền | `HoldExpiryJob` |
| `REFUND_REQUESTED` | Người thuê yêu cầu hoàn, chờ quản trị viên | rental |
| `REFUNDED` | Đã hoàn 70% cho người thuê; chủ trọ vẫn rút được phần còn lại, đơn giữ `REFUNDED` (BR-15 sửa) | rental khi nhận `DepositRefunded` (`payment.refunded`) |
| `RELEASED` | Đã giải ngân, chờ chủ trọ rút | người thuê hoặc `AutoReleaseJob` |
| `WITHDRAWN` | Đã chi cho chủ trọ | rental khi nhận `WithdrawalCompleted` (`payment.withdrawal-completed`) |
| `CANCELLED` | Saga thất bại sau khi giữ chỗ (chốt A1, không có trong Bảng 3.4) | `CompensationService` |

## Trạng thái khác

| Thực thể | Giá trị | Nguồn |
|---|---|---|
| BĐS `listings.status` | `AVAILABLE`, `HELD`, `DEPOSITED`, `RENTED`, `HIDDEN` | Báo cáo Bảng 3.5 |
| Duyệt tin `listings.approval_status` | `PENDING_REVIEW`, `APPROVED`, `REJECTED` | Chốt 2026-11-16 |
| Lịch xem `viewings.status` | `REQUESTED`, `DECLINED`, `CONFIRMED`, `CANCELLED` | Chốt 2026-11-16 |
| Lý do hủy lịch xem `viewings.cancel_reason` | `TENANT`, `LISTING_DEPOSITED` | Chốt 2026-11-16 |
| Payment order | `PENDING`, `PAID`, `CANCELLED` | Chốt 2026-11-16 |
| Yêu cầu hoàn | `PENDING_ADMIN`, `COMPLETED`, `REJECTED`, `FAILED` | Báo cáo §3.2.3 |
| Lệnh rút | `PENDING`, `COMPLETED`, `FAILED` | Báo cáo §3.2.4 |
| Loại giao dịch ví | `DEPOSIT_IN`, `LATE_PAYMENT_IN`, `WITHDRAW_OUT`, `REFUND_OUT` | Báo cáo §3.4 |
| Người yêu cầu hoàn | `TENANT`, `SYSTEM` | Báo cáo §3.4 |
| `saga_log.outcome` | `OK`, `BUSINESS_ERROR`, `NOT_EXECUTED`, `UNKNOWN` | Chốt 2026-11-16 (C14) |
| Kích hoạt giải ngân | `TENANT`, `AUTO` | Báo cáo Bảng 3.13 |
| Loại BĐS `listings.property_type` | `ROOM`, `APARTMENT`, `HOUSE` | Chốt 2026-11-16 |
| Loại hội thoại | `TENANT_LANDLORD`, `SUPPORT` | Chốt 2026-11-16 |

## Thuật ngữ kỹ thuật

| Thuật ngữ | Định nghĩa trong dự án |
|---|---|
| **Giữ chỗ (hold)** | Chuyển BĐS `AVAILABLE → HELD` có hạn `held_until`, bằng một câu `UPDATE` có điều kiện |
| **Saga** | Chuỗi transaction cục bộ ở rental, listing, payment; rental điều phối (ADR-0004) |
| **Bù trừ (compensation)** | Nhả chỗ giữ, hủy link payOS, hoàn tiền |
| **Đối soát (reconcile)** | `SagaReconcileJob` xử lý đơn dừng giữa chừng dựa trên `saga_log` và tra cứu payment order |
| **Bản chụp (snapshot)** | Bản sao dữ liệu tại thời điểm giao dịch, ví dụ tiền cọc trong đơn |
| **Idempotent** | Gọi lại nhiều lần không làm dữ liệu đổi thêm |
| **`Idempotency-Key`** | Header client gửi cho thao tác ghi quan trọng; kết quả lưu Redis 24 giờ (`@Idempotent()`, mọi service kể cả payment) |
| **OTP** | Mã 6 số gửi qua email để xác minh tài khoản mới; hiệu lực 5 phút, sai 5 lần hủy (Bảng 2.6) |
| **Khóa tài khoản** | Quản trị viên đặt `users.status = LOCKED`: chặn đăng nhập, thu hồi refresh token; không đụng tin, đơn, tiền |
| **Outbox** | Bảng `outbox_events` lưu sự kiện cùng transaction với dữ liệu |
| **Inbox** | Bảng `processed_events`, consumer chống xử lý trùng |
| **Webhook** | Lời gọi ngược từ payOS báo kết quả thanh toán. Trang `returnUrl` **không** có giá trị xác nhận |
| **Bàn giao** | Quản trị viên chuyển đơn `PAID` sang chủ trọ (`admin_confirmed_at`) |
| **Giải ngân** | Đơn `RELEASED`: tiền thuộc chủ trọ, chờ rút |
| **Chứng từ** | Ảnh chuyển khoản quản trị viên tải lên, bắt buộc để hoàn tất hoàn/rút |
| **API nội bộ** | `/internal/*`, gateway không mở ra ngoài |
| **Correlation ID** | `X-Request-ID`, có ở mọi dòng log và sự kiện (`correlationId`) |
| **Envelope** | Khung response `{ data, meta }` / `{ error, meta }`, và phong bì sự kiện |
