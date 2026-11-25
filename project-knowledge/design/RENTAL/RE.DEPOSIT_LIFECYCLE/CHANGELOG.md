# RE.DEPOSIT_LIFECYCLE — Nhật ký thay đổi thiết kế

> Tạo ở lần sửa đầu tiên sau baseline v1.0 (`standards/design-standards.md §9`). Mục mới lên đầu, không sửa mục cũ.

## [v1.2] — 2026-11-25

- **type:** MINOR
- **author:** hoang.lv (A duyệt kế hoạch T3.5 cùng Claude, B1–B10)
- **summary:** Chốt chi tiết khi làm T3.5: quyền xem đơn của chủ trọ, `allowedActions`, nội dung đơn trả về, lọc và phân trang, gửi lại yêu cầu hoàn, đồng bộ tin, `DeadlineJob`, job (c), nội dung `audit_log`, 2 index, `0` tắt lịch. Không đổi route, mã lỗi, hợp đồng.

### Thay đổi

| # | Vị trí | Loại |
|---|---|---|
| 1 | `API_Spec.md` §1 | Thêm "Chốt khi làm T3.5" |
| 2 | `API_Spec.md` §6 | Sửa (`0` tắt lịch) |
| 3 | `API_Spec.md` §7 | Thêm nội dung `audit_log`, 2 index |
| 4 | `Component_Class_Design.md` §4, §4a | Thêm |

- **Cũ:** "landlord chủ tin sau khi xác nhận bàn giao" (route 2) không rõ là sau bàn giao hay sau khi chủ trọ xác nhận; `allowedActions`, nội dung đơn, lọc route 5, cách xử lý khi gửi yêu cầu hoàn lỗi, `DeadlineJob`, job (c) chưa nêu chi tiết; DDL không có index cho route 5 và job (c).
- **Mới:** xem `API_Spec §1` "Chốt khi làm T3.5", `§7`, `Component_Class_Design §4a`.
- **Lý do:** thiết kế chưa nêu; chủ trọ phải mở được đơn để xác nhận (route 7); `non-functional-standards §1` bắt buộc index cột lọc của API danh sách. A duyệt 2026-11-25.

## [v1.1] — 2026-11-16

- **type:** MINOR
- **author:** hoang.lv (A chốt cùng nhóm; người phụ trách code xem lại khi nhận task)
- **summary:** Chốt bàn giao khi đã RELEASED, rental không nghe sự kiện rút, chu kỳ job.

### Thay đổi

**1.**

| # | Vị trí | Loại |
|---|---|---|
| 1 | `API_Spec.md` §1, §4, §6, §8 | Sửa |

- **Cũ:** các điểm `[cần xác nhận]` ở những mục trên.
- **Mới:** giá trị đã chốt, tóm ở mục "Đã chốt 2026-11-16" cuối `API_Spec.md`.
- **Lý do:** chốt trước khi code; ghi ở `implementation/van-de-can-quyet-dinh.md` mục D ngày 2026-11-16.

### File design đã sửa

- `API_Spec.md` §1, §4, §6, §8
- Header 3 file: v1.0 → v1.1

### Ảnh hưởng

- rental (C, T3.5). `definitions.json` không đổi (hai khóa vốn chưa bind).
