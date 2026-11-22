# RE.DEPOSIT_SAGA — Nhật ký thay đổi thiết kế

> Tạo ở lần sửa đầu tiên sau baseline v1.0 (`standards/design-standards.md §9`). Mục mới lên đầu, không sửa mục cũ.

## [v1.3] — 2026-11-22

- **type:** MINOR
- **author:** hoang.lv (A chốt C20 và duyệt kế hoạch T3.3 cùng Claude)
- **summary:** Đóng `[cần xác nhận]` C20; chốt chi tiết bù trừ, đồng bộ listing, `SagaReconcileJob` khi làm T3.3. Không đổi route, mã lỗi, hợp đồng.

### Thay đổi

**1. C20 — listing từ chối khi rental đẩy trạng thái.**

| # | Vị trí | Loại |
|---|---|---|
| 1 | `API_Spec.md` §8 | Đóng điểm mở |
| 2 | `Processing_Flow.md` §3 | Sửa dòng "Nhả chỗ (bù trừ)" |
| 3 | `Component_Class_Design.md` §8 test 17 | Sửa |

- **Cũ:** `409 LISTING_INVALID_STATUS` là `[cần xác nhận]`; test 17 "đẩy lại tới khi xong".
- **Mới:** mọi 4xx của listing khi đẩy trạng thái là kết cục cuối: đánh dấu đã đồng bộ, `saga_log SYNC_LISTING BUSINESS_ERROR` kèm `details`, log `warn`. Chỉ `503`/`504`/kết nối mới đẩy lại.
- **Lý do:** đẩy lại 4xx không bao giờ thành công, job lặp vô hạn. A chốt 2026-11-22 (`van-de-can-quyet-dinh.md` C20, mục D).

**2. Chi tiết T3.3.**

| # | Vị trí | Loại |
|---|---|---|
| 1 | `Component_Class_Design.md` §5, §7 | Thêm |
| 2 | `Processing_Flow.md` §6 | Thêm |
| 3 | `API_Spec.md` §5 | Thêm |

- **Mới:** giá trị `cancelled_reason`; `saga_log` bước lỗi ghi trong transaction bù trừ; đánh dấu đã đồng bộ chỉ khi đích chưa đổi; lỗi tạm không ghi `saga_log`; `@nestjs/schedule` 6.1.3 (12.x là ESM thuần); bỏ lượt khi lượt trước chưa xong, 50 đơn mỗi phần; `SAGA_RECONCILE_INTERVAL_MS=0` tắt lịch; số truy vấn nhánh bù trừ 7 (A chấp nhận).
- **Lý do:** thiết kế chưa nêu; A duyệt kế hoạch T3.3 2026-11-22.

## [v1.2] — 2026-11-20

- **type:** MINOR
- **author:** hoang.lv (A chốt khi duyệt kế hoạch T2.3)
- **summary:** Thêm một điểm `[cần xác nhận]`: cách rental xử lý `409 LISTING_INVALID_STATUS` khi đẩy đích `AVAILABLE`. Không đổi hành vi đã chốt.

### Thay đổi

**1.**

| # | Vị trí | Loại |
|---|---|---|
| 1 | `API_Spec.md` §8 | Thêm |
| 2 | `Processing_Flow.md` §3 (tách dòng "Nhả chỗ", thêm dòng `409`) | Sửa |
| 3 | `Component_Class_Design.md` §8 (test 17, chú thích) | Sửa |

- **Cũ:** "Nhả chỗ (bù trừ) | listing lỗi" và test 17 coi mọi lỗi đồng bộ listing là đẩy lại tới khi xong.
- **Mới:** lỗi kết nối, `503`, `504` vẫn đẩy lại; `409 LISTING_INVALID_STATUS` khi đích `AVAILABLE` (tin đã giao cho đơn khác) ghi `[cần xác nhận]`: đề xuất kết cục cuối, không retry, đánh dấu đã đồng bộ, `saga_log BUSINESS_ERROR`, log `warn`.
- **Lý do:** `RE.LISTING` v1.4 (§2.2) định nghĩa khi nào listing trả `409` cho `PUT /internal/listings/:id/status`; nếu rental coi mọi lỗi là tạm thời thì job (b) lặp mãi trên tin không còn thuộc đơn. Chưa quyết, không sửa rental ở T2.3; xử lý ở T3.x.

### File design đã sửa

- `API_Spec.md` §8 (mới)
- `Processing_Flow.md` §3
- `Component_Class_Design.md` §8
- Header 3 file: v1.1 → v1.2

### Ảnh hưởng

- rental (C, T3.3): chốt cách xử lý trước khi viết `ListingSyncService`. Listing (T2.3) không phụ thuộc quyết định này.
- `contracts/`: không đổi.

## [v1.1] — 2026-11-16

- **type:** MINOR
- **author:** hoang.lv (A chốt cùng nhóm; người phụ trách code xem lại khi nhận task)
- **summary:** Chốt tham số job, phân loại kết quả lời gọi theo outcome của template, mã lỗi listing.

### Thay đổi

**1.**

| # | Vị trí | Loại |
|---|---|---|
| 1 | `API_Spec.md` §5, §7 | Sửa |
| 2 | `Component_Class_Design.md` §3, §6, §7, §9 | Sửa |

- **Cũ:** các điểm `[cần xác nhận]` ở những mục trên.
- **Mới:** giá trị đã chốt, tóm ở mục "Đã chốt 2026-11-16" cuối `API_Spec.md`.
- **Lý do:** chốt trước khi code; ghi ở `implementation/van-de-can-quyet-dinh.md` mục D ngày 2026-11-16.

### File design đã sửa

- `API_Spec.md` §5, §7
- `Component_Class_Design.md` §3, §6, §7, §9
- Header 3 file: v1.0 → v1.1

### Ảnh hưởng

- rental (C, T3.2–T3.4); phụ thuộc sửa `InternalHttpService` của template (A, bước 0 T1.2).
