# RE.LOCATION — Đặc tả API

| | |
|---|---|
| **Mã chức năng** | `RE.LOCATION` — danh mục tỉnh/thành, quận/huyện cho form tạo/sửa tin và bộ lọc tìm kiếm |
| **Service** | `listing` (cổng 3002), trong module `src/listing/` (NFR04: một module nghiệp vụ mỗi service) |
| **Quy tắc** | FR03 (lọc theo quận); không có `BR-xx` |
| **Quyết định** | ADR-0015 (Proposed): địa giới trước 1/7/2025, tin tham chiếu bằng id; ADR-0005 (khóa ngoại chỉ trong một service) |
| **CSDL** | `listing_db` / `listing_user`: `cities`, `districts` |
| **Chủ sở hữu / Cập nhật / Phiên bản** | hoang.lv — 2026-11-26 — v1.0 (đề xuất, chờ A duyệt: `implementation/van-de-can-quyet-dinh.md` C25) |

> Danh mục là **dữ liệu tham chiếu chỉ đọc**: nạp trong migration, không có API ghi, không sửa lúc chạy.
> Địa giới theo mô hình 3 cấp **trước 1/7/2025** (tỉnh/thành → quận/huyện/thị xã/thành phố thuộc tỉnh), 5 tỉnh/thành (§6).
> Tin đăng lưu `city_id`, `district_id` và trả tên qua JOIN: `RE.LISTING` v1.5.

## 1. API công khai

| # | Method, đường dẫn | Quyền | Kết quả |
|---|---|---|---|
| 1 | `GET /api/v1/cities` `[cần xác nhận]` (1) | public | Danh sách tỉnh/thành, phân trang |
| 2 | `GET /api/v1/districts?cityId=` `[cần xác nhận]` (1) | public | Quận/huyện của một tỉnh/thành, phân trang |

Gateway: thêm dòng định tuyến mức `public` (`RE.GATEWAY/API_Spec.md §3`, v1.4).

### 1.1 Request, response

| Route | Query | Response |
|---|---|---|
| 1 | `page`, `pageSize` (`PageQueryDto`: mặc định 1 và 20, tối đa 50) | `200` danh sách `CityDto`, `meta` phân trang. Sắp `sort_order ASC, id ASC` |
| 2 | `cityId` bắt buộc (UUID); `page`, `pageSize` như route 1 | `200` danh sách `DistrictDto` thuộc `cityId`, `meta` phân trang. Sắp `sort_order ASC, id ASC`. `cityId` đúng dạng nhưng không có → `200`, `data: []`, `total: 0` |

| DTO | Trường |
|---|---|
| `CityDto` | `id` (UUID), `name` |
| `DistrictDto` | `id` (UUID), `cityId` (UUID), `name` |

Không trả `sortOrder`, `createdAt`. Id sinh bằng `gen_random_uuid()` lúc migration (`api-convention.md §8`) nên **khác nhau giữa các môi trường**: giao diện, Postman, seed luôn lấy id qua route 1, 2 hoặc tra theo tên, không ghi cứng.

Giao diện gọi `pageSize=50` để nhận đủ trong một trang: tỉnh nhiều nhất là Hà Nội với 30 quận/huyện (§6). Danh mục thêm tỉnh có trên 50 đơn vị thì giao diện phải đọc trang 2.

```jsonc
// GET /api/v1/districts?cityId=0b6d…&pageSize=50
{
  "data": [ { "id": "5f1c…", "cityId": "0b6d…", "name": "Ba Đình" }, … ],
  "meta": { "correlationId": "…", "timestamp": "…", "page": 1, "pageSize": 50, "total": 30, "totalPages": 1 }
}
```

### 1.2 Thứ tự kiểm tra

| # | Điều kiện | Kết quả |
|---|---|---|
| 1 | Route 2: thiếu `cityId` hoặc không phải UUID | `400 VALIDATION_FAILED`, `details: [{ field: "cityId", errors: [...] }]` |
| 2 | `page` < 1, `pageSize` ngoài 1–50, tham số lạ | `400 VALIDATION_FAILED` (`PageQueryDto`, `forbidNonWhitelisted`) |

## 2. API nội bộ

Không có. Service khác không cần danh mục (bản chụp tin ở `RE.LISTING §2` không có địa chỉ).

## 3. Sự kiện

Không phát, không nghe.

## 4. Catalog mã lỗi

Không thêm mã. Chỉ dùng `VALIDATION_FAILED` của template (`api-convention.md §6`). Kiểm cặp `cityId`/`districtId` khi tạo, sửa tin cũng trả `VALIDATION_FAILED` (`RE.LISTING/API_Spec.md §1.2`).

## 5. Biến môi trường

Không thêm.

## 6. DDL và dữ liệu nạp

Migration `1733200000000-create-locations.ts`: tạo bảng, index và nạp dữ liệu trong cùng migration (TypeORM chạy mỗi migration trong một transaction).

```sql
CREATE TABLE cities (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name varchar(100) NOT NULL,
  sort_order smallint NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_cities_name UNIQUE (name)
);
CREATE INDEX ix_cities_sort ON cities (sort_order, id);                    -- route 1 (NFR §1: index cột sắp xếp)

CREATE TABLE districts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  city_id uuid NOT NULL REFERENCES cities(id),                             -- cùng service, có FK (ADR-0005)
  name varchar(100) NOT NULL,
  sort_order smallint NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_districts_city_name UNIQUE (city_id, name)
);
CREATE INDEX ix_districts_city ON districts (city_id, sort_order, id);     -- route 2; kiểm cặp ở RE.LISTING dùng PK
```

`down`: `DROP TABLE districts; DROP TABLE cities;` (phải chạy `down` của migration `RE.LISTING` v1.5 trước vì `listings` có FK tới hai bảng).

**Quy tắc tên:** bỏ tiền tố loại đơn vị ("Quận", "Huyện", "Thị xã", "Thành phố"), giữ "Quận" cho quận đánh số (`Quận 1`); tên tỉnh viết gọn (`Hà Nội`, `Hồ Chí Minh`), khớp tên đang có trong seed `RE.LISTING`. Chuỗi Unicode dạng NFC, dấu thanh kiểu "Hòa".

**Dữ liệu** (80 quận/huyện; `sort_order` theo thứ tự trong bảng: quận → thị xã/thành phố thuộc tỉnh → huyện, mỗi nhóm theo ABC). Đối chiếu danh mục đơn vị hành chính chính thức trước 1/7/2025 khi implement `[cần xác nhận]` (2):

| `sort_order` | Tỉnh/thành | Số | Quận/huyện |
|---|---|---|---|
| 1 | Hà Nội | 30 | Quận: Ba Đình, Bắc Từ Liêm, Cầu Giấy, Đống Đa, Hà Đông, Hai Bà Trưng, Hoàn Kiếm, Hoàng Mai, Long Biên, Nam Từ Liêm, Tây Hồ, Thanh Xuân · Thị xã: Sơn Tây · Huyện: Ba Vì, Chương Mỹ, Đan Phượng, Đông Anh, Gia Lâm, Hoài Đức, Mê Linh, Mỹ Đức, Phú Xuyên, Phúc Thọ, Quốc Oai, Sóc Sơn, Thạch Thất, Thanh Oai, Thanh Trì, Thường Tín, Ứng Hòa |
| 2 | Hồ Chí Minh | 22 | Quận: Quận 1, Quận 3, Quận 4, Quận 5, Quận 6, Quận 7, Quận 8, Quận 10, Quận 11, Quận 12, Bình Tân, Bình Thạnh, Gò Vấp, Phú Nhuận, Tân Bình, Tân Phú · Thành phố: Thủ Đức · Huyện: Bình Chánh, Cần Giờ, Củ Chi, Hóc Môn, Nhà Bè |
| 3 | Đà Nẵng | 8 | Quận: Cẩm Lệ, Hải Châu, Liên Chiểu, Ngũ Hành Sơn, Sơn Trà, Thanh Khê · Huyện: Hòa Vang, Hoàng Sa |
| 4 | Bình Dương | 9 | Thành phố: Bến Cát, Dĩ An, Tân Uyên, Thủ Dầu Một, Thuận An · Huyện: Bàu Bàng, Bắc Tân Uyên, Dầu Tiếng, Phú Giáo |
| 5 | Đồng Nai | 11 | Thành phố: Biên Hòa, Long Khánh · Huyện: Cẩm Mỹ, Định Quán, Long Thành, Nhơn Trạch, Tân Phú, Thống Nhất, Trảng Bom, Vĩnh Cửu, Xuân Lộc |

"Tân Phú" có ở Hồ Chí Minh và Đồng Nai: hợp lệ vì ràng buộc duy nhất là `(city_id, name)`.

## 7. Đã chốt (người dùng trả lời 2026-11-26, chờ A xác nhận ở C25)

1. Mô hình tỉnh → quận/huyện cũ (khớp cột, seed, FR03 "lọc theo quận"), không theo 34 tỉnh + phường/xã.
2. Năm tỉnh/thành: Hà Nội, Hồ Chí Minh, Đà Nẵng, Bình Dương, Đồng Nai.
3. Hai route phẳng `/cities`, `/districts?cityId=`; `cityId` không có → danh sách rỗng, không thêm mã lỗi.
4. Tin đăng gửi `cityId`, `districtId`; `listings` chỉ lưu id, bỏ cột tên (`RE.LISTING` v1.5).
5. Tin cũ không ánh xạ được vào danh mục bị xóa cứng khi migration; `city_id`, `district_id` `NOT NULL` (`RE.LISTING/API_Spec.md §6.1`).

## 8. Điểm [cần xác nhận]

1. Đường dẫn mới `GET /api/v1/cities`, `GET /api/v1/districts` (đường dẫn mới cần nhóm chốt, `design-standards.md §3.1`).
2. Danh sách §6 viết theo hiểu biết của người thiết kế, chưa đối chiếu nguồn chính thức (nhất là Bình Dương, Đồng Nai có đổi đơn vị trong 2023–2025). Developer đối chiếu trước khi viết migration, ghi nguồn vào comment migration.
3. ADR-0015 ở trạng thái `Proposed`: A chốt dùng địa giới cũ dù từ 1/7/2025 cả nước còn 34 tỉnh, không còn cấp huyện.
