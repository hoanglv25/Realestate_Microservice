# RE.SRS — Đặc tả yêu cầu phần mềm Real-estate

> Yêu cầu chức năng, user story, đặc tả use case chi tiết và giao diện ngoài. Đọc khi: cần biết hệ thống phải làm gì và tiêu chí chấp nhận; thiết kế một chức năng mới; viết test chấp nhận.
> Quy tắc nghiệp vụ, tác nhân, máy trạng thái ở `RE.BUSINESS_RULES.md`; yêu cầu phi chức năng ở `standards/non-functional-standards.md §0`. File này chỉ trỏ tới, không chép lại.

| | |
|---|---|
| **Chủ sở hữu / Cập nhật / Phiên bản** | hoang.lv — 2026-11-16 — v1.0 |
| **Nguồn** | Báo cáo v2 Chương 1–3 (Bảng 2.1, 2.4, 3.1–3.3, 4.3, 5.2) |

## 1. Mục đích và phạm vi

Real-estate là nền tảng tìm kiếm, thuê và đặt cọc nhà ở, căn hộ, phòng trọ. Tiền cọc đi qua payOS vào ví trung gian và chỉ được giải ngân hoặc hoàn theo quy tắc (Báo cáo §1.1–1.2).

- **Trong phạm vi:** phần máy chủ (api-gateway và 5 service) phục vụ khách, người thuê, chủ trọ, quản trị viên (Báo cáo §1.3).
- **Giao diện:** Next.js, repo riêng (§6). Không đặc tả màn hình ở đây.
- **Ngoài phạm vi:** `RE.BUSINESS_RULES.md §7`.
- **Môi trường:** Docker Compose trên máy phát triển; payOS chế độ thử nghiệm; webhook qua đường hầm ngrok hoặc cloudflared.

## 2. Tác nhân

Xem `RE.BUSINESS_RULES.md §2` (Báo cáo Bảng 2.3).

## 3. Yêu cầu chức năng

| Mã | Nhóm | Nội dung (Báo cáo Bảng 2.1) | Service chính | Phối hợp (Bảng 4.3) | Use case | Thiết kế |
|---|---|---|---|---|---|---|
| FR01 | Tài khoản và hồ sơ | Đăng ký qua OTP, đăng nhập, khôi phục mật khẩu; hồ sơ cá nhân, tài khoản ngân hàng nhận tiền | identity | notification | UC-ACC-01, UC-ACC-02 | `RE.IDENTITY` |
| FR02 | Quản lý sản phẩm | Chủ trọ thêm, sửa, ẩn/hiện, xóa mềm sản phẩm; giá thuê, tiền cọc, diện tích, tiện ích, tọa độ; tải ảnh; sản phẩm của tôi; quản trị viên duyệt | listing | — | UC-LST-01, UC-LST-02 | `RE.LISTING` |
| FR03 | Tìm kiếm | Lọc giá, diện tích, quận, tiện ích, còn trống; bán kính; phân trang | listing | — | UC-LST-03 | `RE.LISTING` |
| FR04 | Xem nhà | Đặt lịch xem (không chọn giờ, chốt giờ qua chat); chủ trọ xem danh sách người đăng ký và có thể từ chối; người thuê hủy hoặc xác nhận đã xem; tin có người đặt cọc thì yêu cầu xem còn chờ của người khác tự hủy | rental | notification | UC-VIE-01 | `RE.VIEWING` |
| FR05 | Đặt cọc và giữ chỗ | Giữ chỗ 10 phút, link/QR payOS, ghi nhận qua webhook, bàn giao, xác nhận nhận phòng, tự giải ngân sau 3 ngày | rental | listing, payment, notification | UC-DEP-01 … UC-DEP-06 | `RE.DEPOSIT_SAGA`, `RE.DEPOSIT_LIFECYCLE`, `RE.PAYMENT` |
| FR06 | Hoàn tiền và rút tiền | Hoàn 70% trong 48 giờ; hoàn 100% tiền đến muộn; chủ trọ tạo lệnh rút; lịch sử ví | payment | rental, identity, listing | UC-REF-01, UC-WDR-01, UC-WDR-02 | `RE.PAYOUT`, `RE.DEPOSIT_LIFECYCLE` |
| FR07 | Thông báo và nhắn tin | Thông báo từ sự kiện; danh sách, đánh dấu đã đọc; nhắn tin người thuê, chủ trọ, quản trị viên | notification | — | UC-NTF-01, UC-CHT-01 | `RE.NOTIFICATION`, `RE.CHAT` |
| FR08 | Quản trị | Duyệt tin, bàn giao đơn, xử lý hoàn và rút có chứng từ, xem ví trung gian, khóa tài khoản (bỏ đổi vai trò 2026-11-18, lệch Báo cáo v2), nhật ký thao tác | listing, rental, payment, identity | gateway kiểm `ADMIN` | UC-LST-02, UC-DEP-03, UC-WDR-02, UC-ACC-03, UC-ADM-01 | Theo service |

FR01 làm đủ (B10, 2026-11-12): OTP qua email, quên mật khẩu, đăng nhập Google, sửa hồ sơ cá nhân (`fullName`, `phone`), khóa tài khoản (FR08). Thiết kế: `RE.IDENTITY`.

## 4. User story và tiêu chí chấp nhận

Cột "Kiểm chứng" ghép theo nội dung ca kiểm thử của Báo cáo Bảng 5.2 và thí nghiệm Bảng 5.4.

| Mã | Nhu cầu (Báo cáo Bảng 2.4) | Tiêu chí chấp nhận | Kiểm chứng |
|---|---|---|---|
| US01 | Người thuê tìm phòng trong một bán kính quanh nơi học, làm việc | Trả đúng tin trong bán kính; chỉ tin đã duyệt; có phân trang | Báo cáo T05 |
| US02 | Người thuê giữ chỗ một phòng đang trống để thanh toán cọc | Chỉ một người giữ được tại một thời điểm; người đến sau nhận `409`; tiền cọc do máy chủ xác định | Báo cáo T06, T07, T08; E1 |
| US03 | Người thuê biết tiền cọc đang ở đâu | Trang "Đặt cọc của tôi" đúng trạng thái đơn; tiền chỉ ghi nhận khi có webhook hợp lệ | Báo cáo T09, T10 |
| US04 | Người thuê được hoàn nếu đổi ý trong 48 giờ | Hệ thống tự tính 70%; quá 48 giờ hoặc đã nhận phòng thì không tạo được yêu cầu | Báo cáo T11, T12 |
| US05 | Chủ trọ rút tiền cọc khi người thuê đã nhận phòng | Chỉ rút khi đơn `RELEASED`, không có lệnh rút hay hoàn đang mở; mỗi đơn rút một lần | Báo cáo T13 |
| US06 | Quản trị viên xử lý hoàn và rút không chi trùng | Mỗi yêu cầu cần chứng từ; chứng từ đã dùng bị từ chối; ví chỉ bị trừ khi `COMPLETED` | Báo cáo T14; E10 |
| US07 | Người dùng được báo khi đơn đổi trạng thái | Mỗi sự kiện hợp lệ tạo đúng một thông báo, kể cả khi sự kiện bị gửi lại | E3 |
| US08 | Chủ trọ tự thêm, sửa, ẩn, xóa sản phẩm của mình | Chỉ thao tác trên sản phẩm của mình; sản phẩm mới chờ duyệt; không xóa được khi đang có đơn đặt cọc | Báo cáo T04, T18 |

## 5. Đặc tả use case chi tiết

Danh sách đủ 19 use case: `RE.BUSINESS_RULES.md §3`. Mục này chi tiết các use case Báo cáo đã đặc tả. Luồng chính từng bước: `RE.BUSINESS_RULES.md §6`.

### 5.1 UC-DEP-01 Đặt cọc qua payOS (Báo cáo Bảng 3.1)

| Thuộc tính | Nội dung |
|---|---|
| Tác nhân | Người thuê đã đăng nhập; payOS |
| Mục đích | Giữ một BĐS đang trống và thanh toán tiền cọc vào ví trung gian |
| Tiền điều kiện | Tin đã duyệt, BĐS `AVAILABLE`; người thuê có tài khoản hợp lệ |
| Hậu điều kiện thành công | Đơn `PAID`, BĐS `DEPOSITED`, ví có thêm một `DEPOSIT_IN`; `DepositPaid` ghi vào outbox cùng transaction |
| Ngoại lệ | BĐS đã được giữ: `409 LISTING_NOT_AVAILABLE`. Listing hoặc payment không phản hồi: `503`/`504`, chỗ giữ được nhả. Hết 10 phút chưa thanh toán: đơn `EXPIRED`. Webhook sai chữ ký hoặc số tiền: bỏ qua, ghi log |
| Use case liên quan | Bao gồm UC-DEP-02 Giữ chỗ; mở rộng bởi UC-DEP-05 Hết hạn, UC-DEP-06 Tiền đến muộn |
| Liên kết | FR05, US02, US03, BR-04 … BR-10 |

### 5.2 UC-DEP-05, UC-DEP-06 Hết hạn giữ chỗ, tiền đến muộn (Báo cáo §3.2.2)

| Thuộc tính | Nội dung |
|---|---|
| Tác nhân | Công việc nền (`HoldExpiryJob`); payOS; quản trị viên |
| Kích hoạt | Đơn `PENDING_PAYMENT` quá `expires_at` |
| Luồng chính | Rental gọi payment hủy link payOS trước, rồi đơn `EXPIRED`, BĐS `HELD → AVAILABLE`; notification báo người thuê |
| Nhánh tiền đến muộn | Webhook tới sau khi hủy: payment ghi `late_payments`, `LATE_PAYMENT_IN`, tạo yêu cầu hoàn 100% `SYSTEM`; đơn giữ `EXPIRED`; quản trị viên chuyển khoản hoàn |
| Liên kết | FR05, FR06, BR-09, BR-10 |

### 5.3 UC-REF-01 Hoàn tiền (Báo cáo Bảng 3.2)

| Thuộc tính | Nội dung |
|---|---|
| Tác nhân | Người thuê gửi yêu cầu; quản trị viên xử lý |
| Tiền điều kiện | Đơn `PAID`, chưa giải ngân, chưa nhận phòng, không có yêu cầu hoàn hay lệnh rút đang mở; còn trong 48 giờ kể từ lúc thanh toán |
| Luồng chính | Rental chuyển đơn `REFUND_REQUESTED`, gọi payment tạo yêu cầu hoàn 70% `PENDING_ADMIN`; tự giải ngân dừng. Quản trị viên chuyển khoản, tải chứng từ; payment chuyển `COMPLETED`, ghi `REFUND_OUT`, phát `DepositRefunded` |
| Ngoại lệ | Quá 48 giờ hoặc đã nhận phòng: `409`. Từ chối: yêu cầu `REJECTED`, đơn về `PAID`. Chuyển khoản thất bại: `FAILED`, đơn giữ `REFUND_REQUESTED`. Chứng từ đã dùng: `409` |
| Hậu điều kiện | Đơn `REFUNDED`; BĐS `AVAILABLE` |
| Liên kết | FR06, US04, US06, BR-12, BR-16, BR-17 |

Phần 30% của chủ trọ khi người thuê hủy: chủ trọ rút bằng một lệnh rút gắn với đơn `REFUNDED` (BR-15 sửa 2026-11-12, `RE.PAYOUT §1.1`).

### 5.4 UC-WDR-01, UC-WDR-02 Rút tiền (Báo cáo Bảng 3.3)

| Thuộc tính | Nội dung |
|---|---|
| Tác nhân | Chủ trọ tạo lệnh rút; quản trị viên xử lý |
| Tiền điều kiện | Đơn `RELEASED`, đã có mốc bàn giao và chủ trọ xác nhận; hoặc đơn `REFUNDED` do người thuê tự hủy (phần còn lại, không cần hai mốc). Không có lệnh rút hay yêu cầu hoàn đang mở; chủ trọ đã khai tài khoản ngân hàng |
| Luồng chính | Payment hỏi rental điều kiện rút, hỏi identity tài khoản nhận, tạo lệnh `PENDING`. Quản trị viên chuyển khoản ngoài hệ thống, tải chứng từ; payment chuyển `COMPLETED`, ghi `WITHDRAW_OUT`, phát `WithdrawalCompleted`; rental chuyển đơn `WITHDRAWN` |
| Ngoại lệ | Thiếu điều kiện: `409` kèm điều kiện còn thiếu. Chuyển khoản thất bại: lệnh `FAILED`, ví không bị trừ, chủ trọ sửa tài khoản rồi tạo lệnh mới |
| Hậu điều kiện | Đơn `WITHDRAWN` (đơn `REFUNDED` giữ nguyên); ví giảm đúng số tiền đã chi |
| Liên kết | FR06, US05, US06, BR-15 … BR-17 |

## 6. Giao diện ngoài

| Bên ngoài | Giao tiếp | Đặc tả |
|---|---|---|
| Giao diện Next.js (repo riêng: https://github.com/dotrungthanhCC01/real-estate) | REST qua gateway cổng 8080, `/api/v1/*`; Socket.IO cho thông báo, tin nhắn | `design/SHARED/RE.GATEWAY/API_Spec.md`, `design/NOTIFICATION/RE.CHAT/API_Spec.md` |
| payOS | Tạo, hủy, tra cứu link (payment gọi ra); webhook (payOS gọi vào qua gateway) | `design/PAYMENT/RE.PAYMENT/API_Spec.md` |
| Object storage API S3: Cloudflare R2 (ADR-0016, thay Silo 2026-11-26) | Ảnh sản phẩm, chứng từ chuyển khoản; presigned URL | `design/SHARED/RE.SERVICE_TEMPLATE/`, `RE.LISTING`, `RE.PAYOUT` |
| SMTP (Mailpit khi dev) | identity gửi email OTP, link đặt lại mật khẩu | `design/IDENTITY/RE.IDENTITY/API_Spec.md §1.6–1.7` |
| Google Sign-In | Next.js lấy ID token; identity kiểm chữ ký | `design/IDENTITY/RE.IDENTITY/API_Spec.md §1.8` |

## 7. Yêu cầu phi chức năng

NFR01–NFR08: `standards/non-functional-standards.md §0` (Báo cáo Bảng 2.2).

## 8. Truy vết

Yêu cầu đề bài → thiết kế → task → bằng chứng: `requirements-traceability.md`.
