# RE.PAYMENT — Nhật ký thay đổi thiết kế

> Tạo ở lần sửa đầu tiên sau baseline v1.0 (`standards/design-standards.md §9`). Mục mới lên đầu, không sửa mục cũ.

## [v1.3] — 2026-11-22

- **type:** MINOR
- **author:** hoang.lv (A duyệt kế hoạch T3.4a cùng Claude)
- **summary:** Khớp mã giả webhook với bảng `API_Spec §1`; chốt các chi tiết làm T3.4a. Không đổi route, mã lỗi, hợp đồng.

### Thay đổi

**1. Sai số tiền chỉ xét order `PENDING`.**

| # | Vị trí | Loại |
|---|---|---|
| 1 | `Component_Class_Design.md` §3 | Sửa mã giả |

- **Cũ:** mã giả kiểm số tiền **trước** khi xét trạng thái order (order `CANCELLED` sai tiền thành `AMOUNT_MISMATCH`).
- **Mới:** đúng `API_Spec §1` dòng 5, 8, 9 và `§7` mục 2: chỉ order `PENDING` bị `AMOUNT_MISMATCH`; `CANCELLED`/`PAID` ghi tiền đến muộn với số thực nhận. Trong transaction `UPDATE` order trước, ghi `result` sau; thua lệnh hủy → `LATE` (không đọc lại order).
- **Lý do:** hai tài liệu lệch nhau; `API_Spec` cụ thể hơn và đúng BR-10 (tiền đã vào tài khoản phải được hoàn). A chốt 2026-11-22.

**2. Chi tiết webhook.**

| # | Vị trí | Loại |
|---|---|---|
| 1 | `API_Spec.md` §1 | Thêm |
| 2 | `API_Spec.md` §1.2 | Sửa thứ tự |
| 3 | `API_Spec.md` §5 | Sửa |
| 4 | `Processing_Flow.md` §6 | Sửa |

- **Mới:** body `200` cố định `{received: true}`; `result` tạm `RECEIVED`; `paidAt` = `transactionDateTime` giờ VN; tiền đến muộn ghi yêu cầu hoàn trước `late_payments` (8 truy vấn thay vì 9); `RABBITMQ_URL` bắt buộc với payment; bảng số truy vấn theo nhánh, nhánh đua 9 (A chấp nhận).
- **Lý do:** thiết kế chưa nêu; A duyệt kế hoạch T3.4a 2026-11-22.

## [v1.2] — 2026-11-21

- **type:** PATCH
- **author:** hoang.lv
- **summary:** Ghi hai chỗ thiết kế bỏ ngỏ phát hiện khi làm T3.1 (C22, C23); không đổi luật, route, mã lỗi, hợp đồng.

### Thay đổi

**1.**

| # | Vị trí | Loại |
|---|---|---|
| 1 | `API_Spec.md` §8 (mới) | Thêm điểm `[cần xác nhận]` |

- **Cũ:** §2c "hỏi payOS nếu `PENDING` mà chưa có link" không nói dùng kết quả; §2a không có dòng cho "gọi lại khi `PENDING` chưa có link".
- **Mới:** ghi hai điểm vào §8 kèm cách T3.1 đang làm (chỉ đọc DB; trả `503`) và đề xuất.
- **Lý do:** bám `CLAUDE.md` §8 (chỗ chưa rõ ghi `[cần xác nhận]`, không tự thêm luật). Chờ A chốt.

## [v1.1] — 2026-11-16

- **type:** MINOR
- **author:** hoang.lv (A chốt cùng nhóm; người phụ trách code xem lại khi nhận task)
- **summary:** Chốt trạng thái order, xử lý tiền đến muộn sai số, cấu hình payOS.

### Thay đổi

**1.**

| # | Vị trí | Loại |
|---|---|---|
| 1 | `API_Spec.md` §1, §2, §5, §6, §7 | Sửa |
| 2 | `Component_Class_Design.md` §5 | Sửa |

- **Cũ:** các điểm `[cần xác nhận]` ở những mục trên.
- **Mới:** giá trị đã chốt, tóm ở mục "Đã chốt 2026-11-16" cuối `API_Spec.md`.
- **Lý do:** chốt trước khi code; ghi ở `implementation/van-de-can-quyet-dinh.md` mục D ngày 2026-11-16.

### File design đã sửa

- `API_Spec.md` §1, §2, §5, §6, §7
- `Component_Class_Design.md` §5
- Header 3 file: v1.0 → v1.1

### Ảnh hưởng

- payment (C, T3.1, T3.4). `contracts/` không đổi.
