# RE.LISTING — Nhật ký thay đổi thiết kế

> Tạo ở lần sửa đầu tiên sau baseline v1.0 (`standards/design-standards.md §9`). Mục mới lên đầu, không sửa mục cũ.

## [v1.5] — 2026-11-26

- **type:** MAJOR
- **author:** Claude (đề xuất theo trả lời của người dùng 2026-11-26), chờ A duyệt (`implementation/van-de-can-quyet-dinh.md` C25)
- **summary:** Tin đăng tham chiếu danh mục địa giới `RE.LOCATION` bằng `cityId`, `districtId`; bỏ cột chuỗi `city`, `district`; tìm kiếm lọc theo id.

### Thay đổi

**1.** Hợp đồng route 1, 2 (body), response `ListingDto`, `ListingSummaryDto`.

| # | Vị trí | Loại |
|---|---|---|
| 1 | `API_Spec.md` §1.1 (bảng trường, bảng duyệt lại), §1.2 (mục 2a), §1.4 | Sửa |

- **Cũ:** body có `city`, `district` dạng chuỗi tự do 1–100 ký tự; response trả lại đúng chuỗi đó.
- **Mới:** body có `cityId`, `districtId` (UUID, bắt buộc khi tạo, đi cùng nhau khi sửa, quận phải thuộc tỉnh → `400 VALIDATION_FAILED` nếu sai); response có `cityId`, `districtId` và tên `city`, `district` đọc qua JOIN.
- **Lý do:** form tạo tin chọn từ danh sách thay vì gõ tự do (yêu cầu người dùng 2026-11-26); chuỗi tự do làm bộ lọc quận (FR03) trượt khi gõ khác chữ.

**2.** Tìm kiếm (route 11).

| # | Vị trí | Loại |
|---|---|---|
| 2 | `API_Spec.md` §1.3 | Sửa |

- **Cũ:** `district` so khớp đúng chuỗi.
- **Mới:** `districtId`, `cityId` (UUID) so khớp `district_id`, `city_id`.
- **Lý do:** cột chuỗi bị bỏ (mục 3).

**3.** DDL, migration, seed.

| # | Vị trí | Loại |
|---|---|---|
| 3 | `API_Spec.md` §6, §6.1 (mới) | Sửa, thêm |

- **Cũ:** `listings.district`, `listings.city` `varchar(100)`; `ix_listings_search` trên `district`.
- **Mới:** `city_id`, `district_id` `NOT NULL`, có FK tới `cities`, `districts`; migration ánh xạ theo tên, **xóa cứng** tin không ánh xạ được (và ảnh của tin), rồi bỏ cột chuỗi; `ix_listings_search` trên `district_id`, thêm `ix_listings_city`; seed ghi id bằng truy vấn con theo tên.
- **Lý do:** người dùng chọn chỉ lưu id (2026-11-26), một nguồn tên duy nhất là danh mục.

**4.** Thành phần, test, số truy vấn.

| # | Vị trí | Loại |
|---|---|---|
| 4 | `Component_Class_Design.md` §1 (bảng file v1.5), §3 (test 18 sửa; 22–26 thêm) | Sửa, thêm |
| 5 | `Processing_Flow.md` §5 (tìm kiếm, thêm, sửa) | Sửa |
| 6 | `API_Spec.md` §8 | Sửa |

### File design đã sửa

- `RE.LISTING/API_Spec.md`, `Component_Class_Design.md`, `Processing_Flow.md`: header v1.4 → v1.5.
- Mới: `design/LISTING/RE.LOCATION/` (v1.0). Sửa: `RE.GATEWAY` v1.4 (định tuyến `cities`, `districts`).

### Ảnh hưởng

- **Phá hợp đồng công khai:** client gửi `city`/`district` nhận `400` (`forbidNonWhitelisted`). Giao diện (repo `real-estate`) sửa form tạo/sửa tin, trang chi tiết (đọc thêm id) và bộ lọc tìm kiếm cùng đợt. `services/listing/openapi.json` xuất lại.
- API nội bộ, sự kiện, `contracts/`: không đổi (bản chụp route a không có địa chỉ).
- Dữ liệu dev: tin có tên không khớp danh mục bị xóa cứng cùng ảnh (`§6.1` bước 3); object S3 của ảnh nằm lại; đơn ở rental trỏ tới tin đó nhận `404` khi gọi API nội bộ.
- Task: `implementation/PHASE-2.md` T2.6.

## [v1.4] — 2026-11-20

- **type:** MINOR
- **author:** hoang.lv (A duyệt kế hoạch T2.3 cùng ngày)
- **summary:** Chốt response và ngữ nghĩa query của tìm kiếm (route 11), ba index cho lọc và sắp xếp, quy tắc idempotent của đổi trạng thái theo đơn, cách chứng minh `EXPLAIN` khi chưa có seed.

### Thay đổi

**1.**

| # | Vị trí | Loại |
|---|---|---|
| 1 | `API_Spec.md` §1.3 (bảng ngữ nghĩa query, thứ tự, điều kiện nền) | Sửa |
| 2 | `API_Spec.md` §1.4 (`ListingSummaryDto`, route 11) | Thêm |
| 3 | `API_Spec.md` §2 (route a), §2.1 (`heldUntil`), §2.2 (bảng idempotent, `details`) | Sửa |
| 4 | `API_Spec.md` §6 (`ix_listings_amenities`, `ix_listings_created`, `ix_listings_area`) | Thêm |
| 5 | `API_Spec.md` §7 (mục 11–15) | Thêm |
| 6 | `Component_Class_Design.md` §1, §2, §3 (test 4, 10, 11 sửa; test 18–21 thêm), §4 | Sửa |
| 7 | `Processing_Flow.md` §5 (dòng tìm kiếm, bản chụp), §6 (tìm kiếm theo bán kính) | Sửa, thêm |

- **Cũ:** §1.3 chỉ liệt kê tên tham số; response route 11 chưa có hình dạng; DDL §6 không có index cho `created_at` (sắp `newest` mặc định), `amenities` (`@>`) và `area_m2` (lọc diện tích); §2.2 viết "đã ở đích với cùng `depositId` → `200`" nên không áp được cho đích `AVAILABLE` (listing xóa `held_by_deposit_id` khi về `AVAILABLE`); test 4 chạy "trên seed" trong khi seed là T2.4, phụ thuộc T2.3.
- **Mới:**
  - Route 11 trả `ListingSummaryDto` (ảnh bìa, `distanceM` khi có `lat/lng`, không `images[]`, `description`). `lat`+`lng` đi cùng nhau; `radiusKm` ∈ (0, 50] và chỉ khi có `lat/lng`; có `lat/lng` không `radiusKm` → không lọc bán kính, vẫn có `distanceM`; `sort=distance` cần `lat/lng`; `district` so khớp đúng chuỗi; `amenities` CSV; mặc định loại `HIDDEN`, vẫn trả `HELD`, `DEPOSITED`, `RENTED`.
  - Ba index mới bắt buộc (không ghi nợ kỹ thuật).
  - Đổi trạng thái: đích `AVAILABLE` và tin đã `AVAILABLE` → `200` với mọi `depositId`; tin thuộc đơn khác → `409 LISTING_INVALID_STATUS` kèm `details { current, target }`; `heldUntil` không kiểm "tương lai".
  - Test 4 chạy trên fixture (tin tọa độ thật + ~5.000 tin ngẫu nhiên đã `ANALYZE`); T2.4 chạy lại `EXPLAIN` bán kính 2 km trên seed.
- **Lý do:** A chốt khi duyệt kế hoạch T2.3 (2026-11-20). Viết trước code theo `design-standards.md §9`; index theo `non-functional-standards.md §1` ("MUST có index cho cột lọc, sắp xếp"); với ~30 dòng seed, planner có thể chọn quét tuần tự nên cần tập dữ liệu đủ lớn mới chứng minh được GiST.

### File design đã sửa

- `API_Spec.md` §1.3, §1.4, §2, §2.1, §2.2, §6, §7
- `Component_Class_Design.md` §1, §2, §3, §4
- `Processing_Flow.md` §5, §6
- Header 3 file: v1.3 → v1.4

### Ảnh hưởng

- listing (T2.3): thêm `ListingSummaryDto`, bộ dựng SQL tìm kiếm, `ListingHoldService`, controller nội bộ; migration thêm 3 index; `listingInvalidStatus` nhận `details`.
- rental (T3.3, C): cần xử lý `409 LISTING_INVALID_STATUS` khi đích `AVAILABLE` là kết cục cuối, không retry (`[cần xác nhận]` ở `RE.DEPOSIT_SAGA/API_Spec.md §8`, `van-de-can-quyet-dinh.md` C20). Không sửa rental ở T2.3.
- T2.4: thêm vào DoD "chạy lại `EXPLAIN` bán kính 2 km trên seed thật".
- `contracts/`: không đổi (`listing-internal.v1.yaml` đã khớp). Gateway: không đổi.

## [v1.3] — 2026-11-20

- **type:** MINOR
- **author:** hoang.lv (A chốt §8 sau khi T2.2 merge)
- **summary:** Chốt hai điểm `[cần xác nhận]` còn lại: trường bắt buộc khi tạo tin, độ dài mô tả, ảnh không xác nhận trên S3.

### Thay đổi

**1.**

| # | Vị trí | Loại |
|---|---|---|
| 1 | `API_Spec.md` §1.1 (`description`, `district`/`city`/`address`) | Sửa |
| 2 | `API_Spec.md` §7 (mục 9–10) | Thêm |
| 3 | `API_Spec.md` §8 | Xóa |

- **Cũ:** §8 ghi `description` ≤ 5000 và `address`, `district`, `city` bắt buộc ở route 1 là đề xuất của Claude, chờ xác nhận; ảnh không xác nhận nằm lại trên S3 cũng để ở §8.
- **Mới:** A chốt đúng như đề xuất; ghi vào §1.1 và §7. DDL §6 không đổi (cột vẫn cho phép `NULL`, chỉ kiểm ở API). §8 không còn điểm nào.
- **Lý do:** business-spec (Báo cáo v2) không quy định; tìm kiếm FR03 lọc theo quận nên tin thiếu quận không lọc ra được. Code T2.2 (PR #19) đã làm theo đề xuất, không phải sửa.

### File design đã sửa

- `API_Spec.md` §1.1, §7, §8
- Header 3 file: v1.2 → v1.3

### Ảnh hưởng

- listing: không đổi code (DTO đã kiểm như trên từ T2.2).
- `contracts/`: không đổi. Gateway: không đổi.

## [v1.2] — 2026-11-19

- **type:** MINOR
- **author:** hoang.lv (A duyệt kế hoạch T2.2 cùng ngày)
- **summary:** Chốt response/request, duyệt lại khi sửa tin `REJECTED`, xác nhận ảnh idempotent, dọn object ảnh không hợp lệ, phạm vi đọc của T2.2.

### Thay đổi

**1.**

| # | Vị trí | Loại |
|---|---|---|
| 1 | `API_Spec.md` §1.1 (bảng duyệt lại) | Sửa |
| 2 | `API_Spec.md` §1.2 (mục 5–8) | Sửa |
| 3 | `API_Spec.md` §1.4, §7, §8 | Thêm |
| 4 | `Component_Class_Design.md` §1, §3 (test 13–17) | Sửa |
| 5 | `Processing_Flow.md` §2, §5 | Sửa |
| 6 | `API_Spec.md` §6 (thêm `ix_listing_images_listing`) | Thêm |

- **Cũ:** chỉ tin `APPROVED` có quy tắc duyệt lại; xác nhận ảnh trùng key chưa nói; ảnh không hợp lệ chỉ trả `400`; chưa có hình dạng response của route 1–10, 12.
- **Mới:** tin `REJECTED` sửa bất kỳ trường hoặc thêm ảnh → `PENDING_REVIEW`; key trùng → `200` kèm ảnh đã có; ảnh không hợp lệ → `deleteObject` (lỗi chỉ log); `ListingDto`, request/response từng route; route 12 vẫn trả tin `HIDDEN`; route 5 trả `204`; `ListingQueryService.findMine/findPublic` làm ở T2.2.
- **Lý do:** A chốt khi duyệt kế hoạch T2.2 (2026-11-19); viết trước code theo `design-standards.md §9`.

### File design đã sửa

- `API_Spec.md` §1.1, §1.2, §1.4 (mới), §7, §8 (mới)
- `Component_Class_Design.md` §1, §3
- `Processing_Flow.md` §2, §5
- Header 3 file: v1.1 → v1.2

### Ảnh hưởng

- listing (T2.2): DTO, `listing-edit.rules.ts`, `ListingImageService` (key trùng, `deleteObject`).
- `StorageService.deleteObject` đã có; `headObject` thêm ở `RE.SERVICE_TEMPLATE` v2.1.
- `contracts/`: không đổi. Gateway: không đổi.

## [v1.1] — 2026-11-16

- **type:** MINOR
- **author:** hoang.lv (A chốt cùng nhóm; người phụ trách code xem lại khi nhận task)
- **summary:** Chốt giá trị cố định, quy tắc duyệt lại khi sửa, giới hạn ảnh và phân trang tìm kiếm.

### Thay đổi

**1.**

| # | Vị trí | Loại |
|---|---|---|
| 1 | `API_Spec.md` §1.1, §1.2, §1.3, §4, §5, §6, §7 | Sửa |
| 2 | `Component_Class_Design.md` §4 | Sửa |

- **Cũ:** các điểm `[cần xác nhận]` ở những mục trên.
- **Mới:** giá trị đã chốt, tóm ở mục "Đã chốt 2026-11-16" cuối `API_Spec.md`.
- **Lý do:** chốt trước khi code; ghi ở `implementation/van-de-can-quyet-dinh.md` mục D ngày 2026-11-16.

### File design đã sửa

- `API_Spec.md` §1.1, §1.2, §1.3, §4, §5, §6, §7
- `Component_Class_Design.md` §4
- Header 3 file: v1.0 → v1.1

### Ảnh hưởng

- listing (B, T2.2, T2.3): DTO, migration (`property_type` NOT NULL + CHECK), mã lỗi mới `LISTING_IMAGE_LIMIT_REACHED`, biến `LISTING_IMAGE_MAX_COUNT`.
