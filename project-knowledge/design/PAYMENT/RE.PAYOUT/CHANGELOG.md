# RE.PAYOUT — Nhật ký thay đổi thiết kế

> Tạo ở lần sửa đầu tiên sau baseline v1.0 (`standards/design-standards.md §9`). Mục mới lên đầu, không sửa mục cũ.

## [v1.3] — 2026-11-25

- **type:** MINOR
- **author:** hoang.lv (A duyệt kế hoạch T3.6 B1–B12)
- **summary:** Đóng §9.1 (quản trị viên xem tài khoản người nhận); chốt chi tiết để code T3.6.

### Thay đổi

**1.**

| # | Vị trí | Loại |
|---|---|---|
| 1 | `API_Spec.md` §1 (route 13, 14), §1.1, §1.2, §1.3, §1.4, §1.5, §2, §4, §6, §8a, §9 | Thêm / Sửa |
| 2 | `Component_Class_Design.md` §1, §4 (test 15–17), §5 | Thêm |
| 3 | `Processing_Flow.md` §2 | Sửa |
| 4 | `API_Spec.md` §7: index danh sách route 3, 4, 5, 12 | Thêm |

- **Cũ:** §9.1 `[cần xác nhận]`; thiết kế chưa nêu: kiểm byte đầu chứng từ, công thức rút đơn `REFUNDED` khi có nhiều yêu cầu hoàn, chống đua tạo lệnh rút, yêu cầu cũ `REJECTED`, sự kiện khi hoàn `SYSTEM`, truy vấn route 1, 11, 12, nội dung `audit_log`, ràng buộc `reason`, trạng thái nguồn của từ chối / thất bại, biến môi trường bắt buộc, index cho danh sách route 3, 4, 5, 12.
- **Mới:** route 13, 14 lấy `bankAccount` từ identity lúc xem (không lưu); các điểm trên chốt theo `API_Spec §8a`.
- **Lý do:** kế hoạch T3.6 (A duyệt 2026-11-25; index theo code-review, A chọn sửa trong T3.6); ghi ở `implementation/van-de-can-quyet-dinh.md` mục D.

### File design đã sửa

- `API_Spec.md`, `Component_Class_Design.md`, `Processing_Flow.md`
- Header 3 file: v1.2 → v1.3

### Ảnh hưởng

- payment (T3.6). Gateway đã phủ `/admin/withdrawals/*`, `/admin/refund-requests/*`. `contracts/` không đổi (route 13, 14 là API công khai). identity không đổi.

## [v1.2] — 2026-11-18

- **type:** MINOR
- **author:** hoang.lv
- **summary:** Ghi `[cần xác nhận]` về cách quản trị viên xem tài khoản nhận tiền của người thuê khi hoàn.

### Thay đổi

**1.**

| # | Vị trí | Loại |
|---|---|---|
| 1 | `API_Spec.md` §9 | Thêm |

- **Cũ:** không nói quản trị viên lấy tài khoản người thuê ở đâu khi hoàn.
- **Mới:** `[cần xác nhận]` kèm đề xuất (gọi API nội bộ identity; chưa khai thì hỏi qua chat `SUPPORT`).
- **Lý do:** phát sinh khi chốt thời điểm khai tài khoản nhận tiền ở T2.1 (`RE.IDENTITY` v2.1).

### File design đã sửa

- `API_Spec.md` §9
- Header 3 file: v1.1 → v1.2

### Ảnh hưởng

- payment (C, T3.6): chốt thiết kế chi tiết khi làm T3.6. `contracts/` không đổi.

## [v1.1] — 2026-11-16

- **type:** MINOR
- **author:** hoang.lv (A chốt cùng nhóm; người phụ trách code xem lại khi nhận task)
- **summary:** Chốt cách tính 70%, tải chứng từ multipart, sự kiện khi hoàn thất bại.

### Thay đổi

**1.**

| # | Vị trí | Loại |
|---|---|---|
| 1 | `API_Spec.md` §1, §2, §6, §8 | Sửa |
| 2 | `Component_Class_Design.md` §4, §5 | Sửa |

- **Cũ:** các điểm `[cần xác nhận]` ở những mục trên.
- **Mới:** giá trị đã chốt, tóm ở mục "Đã chốt 2026-11-16" cuối `API_Spec.md`.
- **Lý do:** chốt trước khi code; ghi ở `implementation/van-de-can-quyet-dinh.md` mục D ngày 2026-11-16.

### File design đã sửa

- `API_Spec.md` §1, §2, §6, §8
- `Component_Class_Design.md` §4, §5
- Header 3 file: v1.0 → v1.1

### Ảnh hưởng

- payment (C, T3.6). `contracts/` không đổi.
