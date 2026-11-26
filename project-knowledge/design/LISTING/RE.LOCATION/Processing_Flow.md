# RE.LOCATION — Luồng xử lý

| | |
|---|---|
| **Chức năng** | Đọc danh mục tỉnh/thành, quận/huyện để chọn trong form tạo/sửa tin và bộ lọc tìm kiếm |
| **Tham chiếu** | `API_Spec.md`, `Component_Class_Design.md`, `RE.LISTING/Processing_Flow.md §5` |
| **Chủ sở hữu / Cập nhật / Phiên bản** | hoang.lv — 2026-11-26 — v1.0 (đề xuất, chờ A duyệt) |

## 1. Form tạo tin chọn địa chỉ

```mermaid
sequenceDiagram
    actor U as Chủ trọ (web)
    participant G as api-gateway
    participant L as listing
    participant DB as listing_db

    U->>G: GET /api/v1/cities?pageSize=50
    G->>L: chuyển tiếp (public, không cần token)
    L->>DB: count + SELECT cities ORDER BY sort_order, id
    L-->>U: 200 [{ id, name }] (5 tỉnh)
    U->>U: chọn tỉnh → xóa quận đang chọn
    U->>G: GET /api/v1/districts?cityId=…&pageSize=50
    G->>L: chuyển tiếp
    L->>DB: count + SELECT districts WHERE city_id ORDER BY sort_order, id
    L-->>U: 200 [{ id, cityId, name }]
    U->>G: POST /api/v1/listings { …, cityId, districtId } (landlord)
    G->>L: chuyển tiếp
    L->>DB: SELECT 1 FROM districts WHERE id AND city_id
    alt cặp không khớp
        L-->>U: 400 VALIDATION_FAILED (details districtId)
    else khớp
        L->>DB: INSERT listings (city_id, district_id, …)
        L-->>U: 201 ListingDto (có cityId, city, districtId, district)
    end
```

Bước tạo, sửa tin và thứ tự kiểm tra đầy đủ: `RE.LISTING/API_Spec.md §1.2`. Bộ lọc tìm kiếm dùng cùng hai route để chọn `cityId`, `districtId` (`RE.LISTING/API_Spec.md §1.3`).

Giao diện có thể giữ danh mục trong bộ nhớ suốt phiên: dữ liệu chỉ đổi khi có migration mới.

## 2. Transaction, đồng thời, gọi lại

- Route 1, 2 chỉ đọc, không transaction, gọi lại bao nhiêu lần cũng như nhau.
- Kiểm cặp trước khi ghi tin nằm ngoài transaction ghi. Không có cửa sổ sai vì danh mục không bao giờ xóa, sửa lúc chạy; FK `listings.district_id → districts.id` vẫn chặn ở DB.

## 3. Khi phụ thuộc lỗi

Postgres lỗi kết nối hoặc chờ quá hạn → `AllExceptionsFilter` trả `503 DEPENDENCY_UNAVAILABLE` / `504 DEPENDENCY_TIMEOUT` (template). Không gọi service khác.

## 4. Số truy vấn

| Endpoint | Truy vấn | Ngưỡng (`non-functional-standards.md §1`) |
|---|---|---|
| `GET /cities` | 1–2 (data; count chỉ khi trang đầu đầy, `findAndCount`) | Danh sách: 4 |
| `GET /districts` | 1–2 (như trên) | Danh sách: 4 |
| Kiểm cặp khi tạo, sửa tin | +1 vào route 1, 2 của `RE.LISTING` | Ghi: 6 (xem `RE.LISTING/Processing_Flow.md §5`) |
