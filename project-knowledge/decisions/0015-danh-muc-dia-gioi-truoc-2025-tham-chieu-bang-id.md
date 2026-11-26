# ADR-0015: Danh mục địa giới theo mô hình tỉnh → quận/huyện trước 1/7/2025, tin đăng tham chiếu bằng id

| | |
|---|---|
| **Trạng thái** | Proposed |
| **Ngày** | 2026-11-26 |
| **Người quyết định** | A (chờ duyệt; người dùng đã chọn phương án 2026-11-26) |
| **Liên quan** | `design/LISTING/RE.LOCATION/` v1.0, `RE.LISTING` v1.5, FR03, ADR-0005, `implementation/van-de-can-quyet-dinh.md` C25 |

## Bối cảnh

Form tạo tin đang cho gõ tự do `city`, `district`; bộ lọc tìm kiếm so khớp đúng chuỗi quận (FR03), nên gõ khác chữ là tin không lọc ra được. Cần danh mục để người dùng chọn.

Từ 1/7/2025 Việt Nam chuyển sang chính quyền địa phương 2 cấp: còn 34 tỉnh/thành, không còn cấp quận/huyện, dưới tỉnh chỉ còn xã/phường. Báo cáo v2, cột `listings.district`, seed (30 tin ở 10 quận Hà Nội) và FR03 đều dùng khái niệm quận.

## Quyết định

Chúng tôi sẽ:

1. Dùng danh mục **tỉnh/thành → quận/huyện theo địa giới trước 1/7/2025**, nạp sẵn 5 tỉnh/thành (Hà Nội, Hồ Chí Minh, Đà Nẵng, Bình Dương, Đồng Nai) trong migration của listing.
2. Lưu danh mục ở `listing_db` (bảng `cities`, `districts`), chỉ đọc, phục vụ qua API public của listing.
3. Tin đăng tham chiếu bằng `city_id`, `district_id` (FK cùng service), bỏ cột chuỗi; tên lấy qua JOIN.

### Phương án đã loại

| Phương án | Lý do loại |
|---|---|
| 34 tỉnh + xã/phường hiện hành | Đổi khái niệm `district` → `ward` ở DDL, seed, bộ lọc, Báo cáo v2; khoảng 3.321 xã; người thuê vẫn quen tìm theo quận. Người dùng không chọn |
| Giữ chuỗi tự do, chỉ thêm API danh sách cho dropdown | Không chặn dữ liệu bẩn từ client khác (Postman); người dùng chọn gửi id |
| Lưu cả id và tên trong `listings` | Hai nguồn tên; người dùng chọn chỉ lưu id |
| Service danh mục riêng hoặc gọi API bên ngoài | Thêm service, đổi ranh giới (`architecture.md`); dữ liệu nhỏ và tĩnh |

## Hệ quả

**Tích cực**

- Bộ lọc quận chính xác; chỉ một nguồn tên.
- Không thêm service, không gọi liên service, không thêm mã lỗi.

**Tiêu cực / đánh đổi**

- Địa giới **không còn đúng pháp lý hiện hành**; địa chỉ hiển thị theo tên cũ (người dùng vẫn quen dùng).
- Đổi hợp đồng công khai đã merge (T2.2, T2.3): giao diện phải sửa cùng đợt.
- Id danh mục khác nhau giữa các môi trường (`gen_random_uuid()`), client không được ghi cứng.

**Cần theo dõi**

- Khi cần địa giới mới: thêm bảng `wards` theo 34 tỉnh và ADR thay thế; không sửa tại chỗ danh mục cũ vì tin đang tham chiếu.
- Mở rộng thêm tỉnh: thêm migration nạp dữ liệu, không sửa migration cũ.
