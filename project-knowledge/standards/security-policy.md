# Chính sách bảo mật

| | |
|---|---|
| **Chủ sở hữu / Cập nhật** | hoang.lv — 2026-11-12 |

## 1. Secret

- Không commit secret thật. `.env` bị ignore; repo chỉ có `.env.example` với giá trị dev vô hại (`change_me_*`).
- Khóa JWT sinh bằng `pnpm keys:generate` vào `secrets/`, không commit.
- `PAYOS_CLIENT_ID`, `PAYOS_API_KEY`, `PAYOS_CHECKSUM_KEY` chỉ nằm trong `.env`, môi trường thử nghiệm.
- `SMTP_PASSWORD` (nếu dùng SMTP thật) chỉ nằm trong `.env`. Không log mã OTP, token đặt lại mật khẩu, ID token Google.
- Mật khẩu ADMIN seed đặt qua biến tạm `SEED_ADMIN_PASSWORD`, không ghi vào `.env`.
- Lỡ commit secret thì coi như đã lộ: đổi key ngay.
- Không đưa key payOS thật vào collection Postman. Dùng biến môi trường.

## 2. Xác thực

| Lớp | Cơ chế |
|---|---|
| Client → gateway | `Authorization: Bearer <accessToken>` (JWT RS256, 15 phút) |
| Gateway | Kiểm chữ ký bằng khóa công khai, hạn, `iss`; kiểm vai trò mức tuyến |
| Gateway → service | Chuyển tiếp `Authorization`; service kiểm lại bằng `JwtAuthGuard` (mặc định mọi route cần JWT) |
| Refresh token | 32 byte ngẫu nhiên, Redis chỉ lưu SHA-256, 7 ngày, xoay vòng theo họ |
| Service → service | `/internal/*` `@Public()`, tin mạng Docker (hạn chế §6) |
| payOS → payment | Chữ ký webhook (`PAYOS_CHECKSUM_KEY`), kiểm ở payment trước mọi xử lý |

Không cấu hình JWT → route không `@Public()` trả `503 AUTH_NOT_CONFIGURED` (không bao giờ để hở).

## 3. Chống giả mạo

1. Gateway trả `404` cho mọi `/internal/*` từ bên ngoài.
2. Hạ tầng và service chỉ publish cổng ra `127.0.0.1`.
3. Webhook payOS: sai chữ ký → bỏ qua, ghi log `warn`, không đổi dữ liệu.
4. Trang `returnUrl` của payOS chỉ để hiển thị, không phải bằng chứng thanh toán.

## 4. Phân quyền

- Gateway chặn thô theo vai trò mức tuyến (ví dụ `/api/v1/admin/*` cần `ADMIN`).
- Service giữ `RolesGuard` (`@Roles('ADMIN')`) **và** kiểm chủ sở hữu: sản phẩm thuộc `ownerId`, đơn thuộc `tenantId`/`ownerId`, giao dịch, thông báo, hội thoại thuộc người gọi (BR-03, BR-19).
- Không tin `userId` trong body; chỉ tin `sub` trong JWT (`@CurrentUser('sub')`).
- `ADMIN` không tự đăng ký (BR-01). Seed không tự nâng quyền người dùng thường.

## 5. Dữ liệu nhạy cảm

- Không log mật khẩu, token, cookie, số tài khoản đầy đủ, chữ ký payOS. Logger ẩn `authorization`, `cookie`, `password`, `token`, `secret` tới độ sâu 3.
- Mật khẩu băm argon2id. `password_hash` không bao giờ nằm trong response.
- Số tài khoản ngân hàng mã hóa khi lưu, chỉ hiển thị bốn số cuối.
- Mỗi service một user database, chỉ có quyền trên database của mình; `REVOKE CONNECT` từ `PUBLIC`.
- Chứng từ chuyển khoản và ảnh lưu S3 dưới key do service đặt; client không tự đặt key.
- Lỗi `5xx` không lộ stack hay message nội bộ.

## 6. Hạn chế đã biết

Ghi vào báo cáo mục Hạn chế (Báo cáo v2 Bảng 7.1):

| Hạn chế | Lý do chấp nhận / hướng xử lý |
|---|---|
| `/internal/*` tin mạng Docker | Phạm vi đồ án. Hướng: xác thực service-to-service hoặc mTLS |
| Access token không thu hồi được trước hạn | Tối đa 15 phút. Hướng: danh sách thu hồi tập trung |
| Hoàn và rút bằng chuyển khoản tay | Rủi ro chuyển sai; bắt buộc chứng từ, `sha256` duy nhất |
| Webhook đi qua đường hầm khi demo | Phụ thuộc ngrok/cloudflared; đối soát bằng API tra cứu payOS |
| Phiên tạo trước khi có set `user-families` không bị `revokeAllForUser` thu hồi cho tới lần refresh kế tiếp | Phiên chưa refresh tự hết hạn, tối đa 7 ngày; hệ thống chưa chạy thật. Phiên mới và phiên đã refresh đều có trong set |
| Số tài khoản ngân hàng mã hóa bằng một khóa, không xoay khóa | Phạm vi đồ án. Hướng: đánh số phiên bản khóa trong dữ liệu mã hóa |
| Mật khẩu dev nằm trong `.env.example` | Chỉ cho môi trường local |
| Tệp lưu ở dịch vụ ngoài (Cloudflare R2); dev và production chung bucket tới go-live | Mã chỉ phụ thuộc API S3 (ADR-0016); bucket riêng tư, token *Object Read & Write* chỉ trên bucket cần dùng; khóa lộ thì thu hồi token ngay; reset bucket cùng database trước go-live |
