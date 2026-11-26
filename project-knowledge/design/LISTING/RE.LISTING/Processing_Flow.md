# RE.LISTING — Luồng xử lý

| | |
|---|---|
| **Chức năng** | Quản lý sản phẩm, tải ảnh, tìm kiếm, giữ chỗ và đổi trạng thái theo đơn |
| **Tham chiếu** | `API_Spec.md`, `Component_Class_Design.md`, ADR-0010 |
| **Chủ sở hữu / Cập nhật / Phiên bản** | hoang.lv — 2026-11-26 — v1.5 (đề xuất, chờ A duyệt: `implementation/van-de-can-quyet-dinh.md` C25) |

## 1. Vòng đời trạng thái BĐS

```mermaid
stateDiagram-v2
    [*] --> AVAILABLE: tạo (approval PENDING_REVIEW)
    AVAILABLE --> HIDDEN: chủ trọ ẩn
    HIDDEN --> AVAILABLE: chủ trọ hiện
    AVAILABLE --> HELD: rental giữ chỗ
    HELD --> AVAILABLE: hết hạn / bù trừ
    HELD --> DEPOSITED: đơn PAID
    DEPOSITED --> RENTED: đơn RELEASED
    DEPOSITED --> AVAILABLE: đơn REFUNDED
```

## 2. Tải ảnh

```mermaid
sequenceDiagram
    participant C as Trình duyệt
    participant L as listing
    participant S3 as S3 (Silo)
    C->>L: POST /listings/:id/images/upload-url { contentType }
    L->>L: kiểm chủ sở hữu, loại file, key = listings/{id}/{uuid}.{ext}
    L-->>C: presigned PUT (Content-Type đã ký)
    C->>S3: PUT ảnh
    C->>L: POST /listings/:id/images { key }
    L->>S3: HeadObject(key)
    alt key đã có trong listing_images
        L-->>C: 200 ảnh đã có
    else quá kích thước / sai loại / không có
        L->>S3: deleteObject(key) (lỗi chỉ ghi log)
        L-->>C: 400 LISTING_IMAGE_INVALID
    else
        L->>L: INSERT listing_images
        L-->>C: 201
    end
```

## 3. Giữ chỗ khi hai người cùng đặt cọc

```mermaid
sequenceDiagram
    participant R1 as rental (đơn A)
    participant R2 as rental (đơn B)
    participant L as listing
    participant DB as listing_db
    R1->>L: POST /internal/listings/x/holds {A}
    R2->>L: POST /internal/listings/x/holds {B}
    L->>DB: UPDATE ... WHERE status='AVAILABLE' (A)
    L->>DB: UPDATE ... WHERE status='AVAILABLE' (B)
    DB-->>L: A: 1 dòng
    DB-->>L: B: 0 dòng
    L-->>R1: 200 HELD
    L-->>R2: 409 LISTING_NOT_AVAILABLE
```

Postgres khóa dòng khi `UPDATE`; lệnh thứ hai chờ rồi đánh giá lại `WHERE`, thấy `HELD` nên 0 dòng. Không cần khóa ứng dụng. Khóa Redis ở rental chỉ chặn bấm lặp sớm.

## 4. Xóa mềm

Một câu `UPDATE listings SET deleted_at = now() WHERE id AND owner_id AND status NOT IN ('HELD','DEPOSITED') AND deleted_at IS NULL`. 0 dòng → đọc lại để chọn `404`/`403`/`409`. Không có cửa sổ giữa kiểm tra và xóa.

## 5. Số truy vấn

| Endpoint | Truy vấn |
|---|---|
| Tìm kiếm | 2 (count + data; ảnh bìa qua `LEFT JOIN LATERAL`, tên tỉnh/quận qua `JOIN` trong cùng câu data, v1.5) |
| Bản chụp nội bộ | 1 |
| Chi tiết | 2 (tin + ảnh) |
| Của tôi | 3 (count + data + ảnh của trang) |
| Thêm, ẩn, hiện | 1–3 (ghi có điều kiện, 0 dòng thì đọc lại để chọn lỗi, đọc ảnh cho response); thêm tin cộng 1 kiểm cặp `cityId`/`districtId` (v1.5) → tối đa 4 |
| Sửa | 3 (đọc tin, `UPDATE ... RETURNING`, ảnh); cộng 1 kiểm cặp khi body có `cityId`/`districtId` (v1.5) → tối đa 4 |
| Xóa mềm | 1, cộng 1 khi 0 dòng |
| Xác nhận ảnh | 5 (đọc tin, khóa tin + đếm + thêm ảnh + đổi duyệt trong một transaction; `HeadObject` ngoài transaction) |
| Duyệt, từ chối | 3 (`UPDATE ... RETURNING`, đọc lại khi 0 dòng, ảnh) |
| Giữ chỗ | 1, cộng 1 khi 0 dòng để phân biệt gọi lại |
| Đổi trạng thái | 1, cộng 1 khi 0 dòng |

## 6. Tìm kiếm theo bán kính

```mermaid
sequenceDiagram
    participant C as Client
    participant L as listing
    participant DB as listing_db (PostGIS)
    C->>L: GET /listings?lat=21.00&lng=105.84&radiusKm=2&sort=distance
    L->>L: kiểm query (lat+lng đi cùng, radiusKm 0..50, sort=distance cần lat/lng)
    L->>DB: SELECT count(*) WHERE nền AND bộ lọc AND ST_DWithin(location, điểm, 2000)
    L->>DB: SELECT ... ST_Distance(location, điểm) AS distanceM, ảnh bìa (LATERAL) ... ORDER BY ... LIMIT/OFFSET
    L->>L: presign ảnh bìa (ký cục bộ, không gọi mạng)
    L-->>C: 200 { data: ListingSummaryDto[], meta phân trang }
```

`ST_DWithin` trên `geography` dùng GiST `ix_listings_location` (Báo cáo T05). Count và data dùng **cùng** mệnh đề `WHERE` do một hàm thuần dựng, nên `total` luôn khớp tập trả về. Không có `lat/lng` thì không có `ST_DWithin`, `ST_Distance`. Mọi giá trị đi qua tham số SQL; cột và hướng sắp xếp lấy từ bảng cố định, không từ input.
