# RE.LISTING — Đặc tả API

| | |
|---|---|
| **Mã chức năng** | `RE.LISTING` — sản phẩm của chủ trọ, duyệt, ảnh, tìm kiếm, giữ chỗ nguyên tử |
| **Service** | `listing` (cổng 3002) |
| **Quy tắc** | BR-03, BR-05, BR-06, BR-14 |
| **Quyết định** | ADR-0010 (gộp sản phẩm vào listing), ADR-0007 (S3) |
| **CSDL** | `listing_db` / `listing_user` (PostGIS, pgcrypto); S3 bucket `listing-images` |
| **Chủ sở hữu / Cập nhật / Phiên bản** | hoang.lv — 2026-11-26 — v1.5 (đề xuất, chờ A duyệt: `implementation/van-de-can-quyet-dinh.md` C25) |

> Báo cáo v2 Bảng 3.8 chỉ liệt kê **thao tác**. Đường dẫn chốt 2026-11-12 (A6); tên trường, giá trị chốt 2026-11-16.

## 1. API công khai

| # | Method, đường dẫn | Quyền | Thao tác (Bảng 3.8) |
|---|---|---|---|
| 1 | `POST /api/v1/listings` | landlord | Thêm sản phẩm, `approvalStatus = PENDING_REVIEW`, `status = AVAILABLE` |
| 2 | `PATCH /api/v1/listings/:id` | landlord, chủ sở hữu | Sửa |
| 3 | `POST /api/v1/listings/:id/hide` | landlord, chủ sở hữu | Ẩn: `AVAILABLE → HIDDEN` |
| 4 | `POST /api/v1/listings/:id/unhide` | landlord, chủ sở hữu | Hiện: `HIDDEN → AVAILABLE` |
| 5 | `DELETE /api/v1/listings/:id` | landlord, chủ sở hữu | Xóa mềm (`deleted_at`) |
| 6 | `GET /api/v1/listings/mine` | landlord | Sản phẩm của tôi, kèm trạng thái duyệt và trạng thái BĐS |
| 7 | `POST /api/v1/listings/:id/images/upload-url` | landlord, chủ sở hữu | Presigned PUT; service đặt key |
| 8 | `POST /api/v1/listings/:id/images` | landlord, chủ sở hữu | Xác nhận key đã tải; `HeadObject` kiểm kích thước |
| 9 | `POST /api/v1/admin/listings/:id/approve` | admin | Duyệt |
| 10 | `POST /api/v1/admin/listings/:id/reject` | admin | Từ chối, lý do bắt buộc |
| 11 | `GET /api/v1/listings` | public | Tìm kiếm, lọc, bán kính, phân trang; chỉ tin `APPROVED`, chưa xóa, không `HIDDEN` |
| 12 | `GET /api/v1/listings/:id` | public | Chi tiết; `404` nếu không có, chưa duyệt, đã xóa |

### 1.1 Trường sản phẩm (route 1, 2)

| Trường | Kiểu | Ràng buộc |
|---|---|---|
| `title` | string | 5–200 ký tự |
| `description` | string | Tùy chọn, ≤ 5000 ký tự (chốt 2026-11-20) |
| `propertyType` | string | `ROOM` (phòng trọ), `APARTMENT` (căn hộ chung cư), `HOUSE` (nhà nguyên căn) |
| `priceVnd` | int | > 0, giá thuê tháng |
| `depositAmountVnd` | int | > 0, tiền cọc (BR-04) |
| `areaM2` | number | > 0 |
| `address` | string | Bắt buộc khi tạo (route 1), ≤ 300 (chốt 2026-11-20) |
| `cityId`, `districtId` | UUID | **v1.5**, thay `city`, `district` dạng chuỗi. Bắt buộc khi tạo (route 1); route 2 gửi **cả hai** hoặc không gửi. `districtId` phải thuộc `cityId` trong danh mục `RE.LOCATION/API_Spec.md §6` (§1.2 mục 2a). Gửi `city`, `district` → `400 VALIDATION_FAILED` (trường lạ) |
| `amenities` | string[] | Mã trong danh mục cố định: `AIR_CONDITIONER`, `WATER_HEATER`, `WASHING_MACHINE`, `FRIDGE`, `WIFI`, `PARKING`, `ELEVATOR`, `PRIVATE_BATHROOM`, `BALCONY`, `FURNISHED`, `PET_ALLOWED`; mã lạ → `400 VALIDATION_FAILED` |
| `lat`, `lng` | number | WGS84 |

Sửa giá hoặc tiền cọc không ảnh hưởng đơn đã tạo (rental giữ bản chụp). Duyệt lại khi sửa (chốt 2026-11-16, bổ sung 2026-11-19):

| Trạng thái duyệt | Sửa gì | Kết quả |
|---|---|---|
| `APPROVED` | `title`, `description`, `propertyType`, `address`/`cityId`/`districtId`, `lat`/`lng`, hoặc thêm ảnh (route 8) | `PENDING_REVIEW`, xóa `reviewed_*` |
| `APPROVED` | `priceVnd`, `depositAmountVnd`, `areaM2`, `amenities` | Giữ `APPROVED` |
| `REJECTED` | **Bất kỳ** trường nào, hoặc thêm ảnh | `PENDING_REVIEW` (nộp lại), xóa `reject_reason`, `reviewed_*` |
| `PENDING_REVIEW` | Bất kỳ | Giữ `PENDING_REVIEW` |

Quy tắc "giá, cọc, diện tích, tiện ích không duyệt lại" chỉ áp cho tin `APPROVED`.

### 1.2 Thứ tự kiểm tra (route 2–5, 7–8; route 1 chỉ có mục 2a)

| # | Điều kiện | Kết quả |
|---|---|---|
| 1 | Không có hoặc đã xóa | `404 LISTING_NOT_FOUND` |
| 2 | `owner_id ≠ sub` | `403 LISTING_NOT_OWNER` (BR-03, Báo cáo T04) |
| 2a | Route 1, 2 (v1.5): có `cityId`/`districtId` mà không có dòng `districts` với `id = districtId AND city_id = cityId` | `400 VALIDATION_FAILED`, `details: [{ field: "districtId", errors: ["Quận/huyện không thuộc tỉnh/thành đã chọn"] }]`. Không thêm mã lỗi (`RE.LOCATION/API_Spec.md §4`) |
| 3 | Route 5: `status ∈ {HELD, DEPOSITED}` | `409 LISTING_HAS_ACTIVE_DEPOSIT` (BR-03, Báo cáo T18) |
| 4 | Route 3: `status ≠ AVAILABLE` | `409 LISTING_INVALID_STATUS` |
| 5 | Route 7: `contentType` ngoài `LISTING_IMAGE_TYPES` | `400 LISTING_IMAGE_INVALID` |
| 6 | Route 8: `key` không thuộc tin này (sai tiền tố `listings/{id}/` hoặc sai dạng), object không tồn tại, vượt `LISTING_IMAGE_MAX_BYTES`, hoặc `Content-Type` không thuộc `LISTING_IMAGE_TYPES` | `400 LISTING_IMAGE_INVALID`. Object có trên S3 nhưng không hợp lệ thì service gọi `deleteObject`; lỗi khi xóa chỉ ghi log `warn`, không đổi kết quả. Key không lưu |
| 7 | Route 8: `key` đã có trong `listing_images` của tin này | `200` kèm ảnh đã có (idempotent), không đổi trạng thái duyệt |
| 8 | Route 7, 8: tin đã có 10 ảnh | `409 LISTING_IMAGE_LIMIT_REACHED` (route 8 kiểm sau mục 7, nên gọi lại cùng key khi đã đủ 10 vẫn `200`) |

### 1.3 Tìm kiếm (route 11)

Query: `minPrice`, `maxPrice`, `minArea`, `maxArea`, `cityId`, `districtId` (v1.5, thay `district`), `amenities` (mọi tiện ích phải có), `available` (chỉ `AVAILABLE`), `lat` + `lng` + `radiusKm`, `page`, `pageSize`, `sort` (`price_asc`, `price_desc`, `newest` mặc định, `distance` chỉ khi có `lat/lng`); `pageSize` mặc định 20, tối đa 50. Có `lat/lng/radiusKm` thì dùng `ST_DWithin` trên `geography` (index GiST, Báo cáo T05).

Ngữ nghĩa chi tiết (chốt 2026-11-20; sai bất kỳ điều nào → `400 VALIDATION_FAILED`):

| Tham số | Kiểu, ràng buộc | Ghi chú |
|---|---|---|
| `minPrice`, `maxPrice` | số nguyên ≥ 0 | Lọc `price_vnd`, gồm cả hai đầu. `minPrice > maxPrice` → `400` |
| `minArea`, `maxArea` | số ≥ 0 | Lọc `area_m2`, gồm cả hai đầu. `minArea > maxArea` → `400` |
| `cityId` | UUID (v1.5) | So khớp `listings.city_id`. Id không có trong danh mục → kết quả rỗng, không lỗi |
| `districtId` | UUID (v1.5, thay `district` chuỗi) | So khớp `listings.district_id`. Có cả `cityId` mà quận không thuộc tỉnh → kết quả rỗng, không lỗi. Gửi `district` → `400` (tham số lạ) |
| `amenities` | CSV, ví dụ `WIFI,PARKING` | Mã trong danh mục §1.1; mã lạ → `400`. Tin phải có **mọi** mã (`amenities @> $1`) |
| `available` | `true` hoặc `false` | `true` chỉ tin `status = AVAILABLE`. Không có hoặc `false`: không lọc thêm, trả `AVAILABLE`, `HELD`, `DEPOSITED`, `RENTED`; luôn loại `HIDDEN` |
| `lat`, `lng` | số, `-90..90` và `-180..180` | **Phải đi cùng nhau**; thiếu một → `400`. Có cả hai thì response có `distanceM` và `sort=distance` hợp lệ |
| `radiusKm` | số, `0 < radiusKm ≤ 50` | Chỉ hợp lệ khi có `lat` và `lng`; thiếu `lat/lng` → `400`. Có `lat/lng` mà không có `radiusKm` → **không lọc bán kính** (vẫn trả `distanceM`, vẫn cho `sort=distance`) |
| `sort` | `newest` (mặc định), `price_asc`, `price_desc`, `distance` | `distance` thiếu `lat/lng` → `400` |
| `page`, `pageSize` | `PageQueryDto` | 1 và 20, tối đa 50 |

Thứ tự (luôn có khóa phụ ổn định, `non-functional-standards.md §1`): `newest` = `created_at DESC, id DESC`; `price_asc` = `price_vnd ASC, created_at DESC, id DESC`; `price_desc` = `price_vnd DESC, created_at DESC, id DESC`; `distance` = khoảng cách tăng dần, rồi `id`.

Điều kiện nền (mọi lần gọi): `approval_status = 'APPROVED' AND deleted_at IS NULL AND status <> 'HIDDEN'`.

### 1.4 Request và response (T2.2 chốt 2026-11-19; route 11 chốt 2026-11-20)

**`ListingDto`** (response của route 1–4, 6, 9, 10, 12; camelCase):

| Trường | Ghi chú |
|---|---|
| `id`, `ownerId` | |
| `title`, `description`, `propertyType`, `priceVnd`, `depositAmountVnd`, `areaM2`, `address`, `amenities`, `lat`, `lng` | như §1.1; `lat`/`lng` đọc từ `location` |
| `cityId`, `districtId`, `city`, `district` | v1.5. `city`, `district` là **tên** đọc bằng truy vấn con theo PK tới `cities`, `districts` trong cùng câu (không lưu ở `listings`). Luôn có giá trị (cột `NOT NULL`, §6.1) |
| `status`, `approvalStatus` | |
| `rejectReason` | `null` khi chưa bị từ chối |
| `images` | `[{ id, url, sortOrder }]` xếp theo `sortOrder`, `createdAt`; `url` là presigned GET (`S3_PRESIGN_TTL_SECONDS`), DB chỉ lưu `object_key` |
| `createdAt`, `updatedAt` | ISO 8601 UTC |

Không trả `version`, `held_until`, `held_by_deposit_id`, `reviewed_by`, `reviewed_at`.

| Route | Request | Response |
|---|---|---|
| 1 | Body: bắt buộc `title`, `propertyType`, `priceVnd`, `depositAmountVnd`, `areaM2`, `address`, `cityId`, `districtId`, `lat`, `lng`; tùy chọn `description` (≤ 5000), `amenities` (mặc định `[]`, không trùng) | `201 ListingDto` |
| 2 | Body: mọi trường của route 1, tùy chọn từng trường, ít nhất một trường; `lat` và `lng` đi cùng nhau; `cityId` và `districtId` đi cùng nhau (v1.5) | `200 ListingDto` |
| 3, 4 | Không body | `200 ListingDto` |
| 5 | Không body | `204` |
| 6 | Query `page`, `pageSize` (20, tối đa 50); sắp `created_at DESC, id DESC`; gồm tin `PENDING_REVIEW`, `APPROVED`, `REJECTED`, `HIDDEN`, không gồm tin đã xóa | `200` danh sách `ListingDto`, `meta` phân trang |
| 7 | Body `{ contentType }` thuộc `LISTING_IMAGE_TYPES` | `200 { uploadUrl, key, expiresInSeconds }`; key `listings/{id}/{uuid}.{ext}`; client `PUT` với đúng `Content-Type` |
| 8 | Body `{ key }` | `201 { id, url, sortOrder }`; key đã có: `200` cùng dạng (mục 7 của §1.2) |
| 9 | Không body | `200 ListingDto`, `approvalStatus = APPROVED`, `reject_reason = NULL` |
| 10 | Body `{ reason }` 1–500 ký tự | `200 ListingDto`, `approvalStatus = REJECTED` |
| 12 | Không | `200 ListingDto` của tin `APPROVED`, chưa xóa. **Tin `HIDDEN` vẫn được trả** (chỉ tìm kiếm, route 11, loại tin `HIDDEN`); `404` khi không có, chưa duyệt hoặc đã xóa |

Giới hạn trường theo DDL §6: `address` ≤ 300, `cityId`, `districtId` là UUID, `areaM2` ≤ 999999.99, `lat` -90..90, `lng` -180..180.

**`ListingSummaryDto`** (response của route 11; camelCase). Là bản gọn của `ListingDto` cho trang kết quả, để số truy vấn không tăng theo số tin (`Processing_Flow.md §5`):

| Trường | Ghi chú |
|---|---|
| `id`, `ownerId` | |
| `title`, `propertyType`, `priceVnd`, `depositAmountVnd`, `areaM2`, `address`, `cityId`, `city`, `districtId`, `district`, `amenities`, `lat`, `lng` | như `ListingDto` |
| `status` | `AVAILABLE`, `HELD`, `DEPOSITED` hoặc `RENTED` (không bao giờ `HIDDEN`) |
| `coverImageUrl` | Presigned GET của ảnh có `sort_order` nhỏ nhất (rồi `created_at`, `id`); `null` khi tin chưa có ảnh |
| `distanceM` | Số nguyên, mét, làm tròn; **chỉ có khi** request có `lat` và `lng` |
| `createdAt` | ISO 8601 UTC |

Không có `description`, `images[]`, `approvalStatus`, `rejectReason`, `updatedAt` (xem chi tiết ở route 12). Route 11: `200` danh sách `ListingSummaryDto`, `meta` phân trang (`api-convention.md §4`).

## 2. API nội bộ

Hợp đồng: `contracts/openapi/listing-internal.v1.yaml` (viết lại ở T0.3, 2026-11-13). Hợp đồng là nguồn chi tiết cho request, response, example.

| # | Method, đường dẫn | Bên gọi | Kết quả |
|---|---|---|---|
| a | `GET /internal/listings/:id` | rental (S1) | Bản chụp: `id, ownerId, title, depositAmountVnd, status, approvalStatus` (đổi tên theo thuật ngữ, bỏ `landlordName`, `isPublished`, chốt 2026-11-13). Trả cả tin `HIDDEN` và chưa duyệt (rental tự xử lý); chỉ tin đã xóa mềm hoặc không có → `404 LISTING_NOT_FOUND` |
| b | `POST /internal/listings/:id/holds` | rental (S1) | Giữ chỗ. Body `{ depositId, heldUntil }`. `200 { status: 'HELD', heldUntil }`; `409 LISTING_NOT_AVAILABLE` |
| c | `PUT /internal/listings/:id/status` | rental (S1) | Đổi trạng thái theo đơn. Body `{ depositId, status }`, `status ∈ {AVAILABLE, DEPOSITED, RENTED}` |

### 2.1 Giữ chỗ (b) — BR-05, BR-06

Một câu lệnh:

```sql
UPDATE listings
SET status = 'HELD', held_until = $heldUntil, held_by_deposit_id = $depositId, version = version + 1
WHERE id = $id AND deleted_at IS NULL AND approval_status = 'APPROVED'
  AND (status = 'AVAILABLE' OR (status = 'HELD' AND held_until < now()))
RETURNING status, held_until;
```

| Kết quả | Response |
|---|---|
| 1 dòng | `200` |
| 0 dòng, nhưng `held_by_deposit_id = depositId` và `status = HELD` | `200` (gọi lại cùng đơn) |
| 0 dòng | `409 LISTING_NOT_AVAILABLE` |

`heldUntil` do rental sinh (`now + HOLD_TTL_SECONDS`); listing chỉ kiểm là chuỗi date-time hợp lệ, **không** thêm luật "phải ở tương lai" (chốt 2026-11-20). Câu `UPDATE` cũng đặt `updated_at = now()`.

Điều kiện `HELD AND held_until < now()` để chỗ giữ của một đơn không tạo được (listing đã `HELD` nhưng rental không nhận được trả lời) tự hết hiệu lực — đây là cách hiện thực câu "`held_until` vẫn bảo đảm chỗ được nhả khi hết hạn" ở Báo cáo §4.7.2 (A9).

### 2.2 Đổi trạng thái (c)

Idempotent (chốt 2026-11-20). Khi câu `UPDATE` không khớp dòng nào, listing đọc lại tin rồi quyết định:

| Tình huống đọc lại | Kết quả |
|---|---|
| Không có tin hoặc đã xóa | `404 LISTING_NOT_FOUND` |
| Đích `DEPOSITED` hoặc `RENTED`, tin đã ở đích **và** `held_by_deposit_id = depositId` | `200`, không đổi |
| Đích `AVAILABLE`, tin đã `AVAILABLE` | `200` với **mọi** `depositId`, không đổi. Lý do: về `AVAILABLE` đã xóa `held_by_deposit_id`, nên lần gọi lại không còn kiểm được "cùng `depositId`"; rental retry bù trừ vẫn phải nhận `200` |
| Còn lại (cặp không có trong bảng, hoặc tin đang `HELD`/`DEPOSITED`/`RENTED` thuộc đơn **khác**, hoặc ở trạng thái khác) | `409 LISTING_INVALID_STATUS`, `details { current, target }` |

Mỗi chuyển là một `UPDATE ... WHERE id AND deleted_at IS NULL AND status = <từ> AND held_by_deposit_id = $depositId`, `version = version + 1`, `updated_at = now()`. API này **không** kiểm `approval_status`.

| Từ | Sang | Khi | Điều kiện |
|---|---|---|---|
| `HELD` | `AVAILABLE` | Hết hạn, bù trừ | `held_by_deposit_id = depositId` |
| `HELD` | `DEPOSITED` | Đơn `PAID` | như trên |
| `DEPOSITED` | `RENTED` | Đơn `RELEASED` | như trên |
| `DEPOSITED` | `AVAILABLE` | Đơn `REFUNDED` | như trên |

Sai cặp → `409 LISTING_INVALID_STATUS`. Về `AVAILABLE` thì xóa `held_until`, `held_by_deposit_id`.

## 3. Sự kiện

Không phát, không nghe (Báo cáo v2 §4.2).

## 4. Catalog mã lỗi

| Mã | HTTP | Thông báo | Quy tắc | Nguồn |
|---|---|---|---|---|
| `LISTING_NOT_FOUND` | 404 | Không tìm thấy tin đăng | | Báo cáo, hợp đồng |
| `LISTING_NOT_AVAILABLE` | 409 | Bất động sản đang được người khác giữ chỗ | BR-05, BR-06, BR-14 | Báo cáo |
| `LISTING_NOT_OWNER` | 403 | Bạn không phải chủ tin đăng này | BR-03 | Đề xuất |
| `LISTING_HAS_ACTIVE_DEPOSIT` | 409 | Tin đang có đơn đặt cọc, không thể xóa | BR-03 | Đề xuất |
| `LISTING_INVALID_STATUS` | 409 | Không thể chuyển trạng thái tin | | Đề xuất |
| `LISTING_ALREADY_REVIEWED` | 409 | Tin đã được duyệt hoặc từ chối | | Đề xuất |
| `LISTING_IMAGE_INVALID` | 400 | Ảnh không hợp lệ hoặc vượt kích thước | | Đề xuất |
| `LISTING_IMAGE_LIMIT_REACHED` | 409 | Tin đã đủ 10 ảnh | | Chốt 2026-11-16 |

## 5. Biến môi trường

| Biến | Mặc định dev | Ý nghĩa |
|---|---|---|
| `PORT` | `3002` | |
| `DATABASE_URL` | `postgres://listing_user:…@localhost:5433/listing_db` | |
| `S3_*`, `S3_BUCKETS` | `listing-images` | |
| `LISTING_IMAGE_MAX_BYTES` | `5242880` (5 MB) | |
| `LISTING_IMAGE_MAX_COUNT` | `10` | Số ảnh tối đa mỗi tin |
| `LISTING_IMAGE_TYPES` | `image/jpeg,image/png,image/webp` | |

## 6. DDL (đề xuất theo Báo cáo Bảng 3.5)

```sql
CREATE TABLE listings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id uuid NOT NULL,                              -- tham chiếu identity, không FK
  title varchar(200) NOT NULL,
  description text,
  property_type varchar(20) NOT NULL CHECK (property_type IN ('ROOM','APARTMENT','HOUSE')),
  price_vnd bigint NOT NULL CHECK (price_vnd > 0),
  deposit_amount_vnd bigint NOT NULL CHECK (deposit_amount_vnd > 0),
  area_m2 numeric(8,2) NOT NULL,
  address varchar(300),
  city_id uuid NOT NULL REFERENCES cities(id),         -- v1.5, thay city varchar(100) (RE.LOCATION §6)
  district_id uuid NOT NULL REFERENCES districts(id),  -- v1.5, thay district varchar(100)
  location geography(Point, 4326) NOT NULL,
  amenities text[] NOT NULL DEFAULT '{}',
  status varchar(20) NOT NULL DEFAULT 'AVAILABLE'
    CHECK (status IN ('AVAILABLE','HELD','DEPOSITED','RENTED','HIDDEN')),
  approval_status varchar(20) NOT NULL DEFAULT 'PENDING_REVIEW'
    CHECK (approval_status IN ('PENDING_REVIEW','APPROVED','REJECTED')),
  reject_reason varchar(500),
  reviewed_by uuid, reviewed_at timestamptz,
  held_until timestamptz,
  held_by_deposit_id uuid,                             -- A8, không có trong Bảng 3.5
  version int NOT NULL DEFAULT 0,
  deleted_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ix_listings_location ON listings USING GIST (location);
CREATE INDEX ix_listings_search ON listings (approval_status, status, district_id) WHERE deleted_at IS NULL;  -- v1.5: district → district_id
CREATE INDEX ix_listings_city ON listings (approval_status, status, city_id) WHERE deleted_at IS NULL;        -- v1.5: lọc cityId
CREATE INDEX ix_listings_price ON listings (price_vnd);
CREATE INDEX ix_listings_owner ON listings (owner_id, created_at DESC);
-- v1.4 (T2.3): index cho cột lọc, sắp xếp của route 11 (non-functional-standards.md §1, MUST)
CREATE INDEX ix_listings_amenities ON listings USING GIN (amenities);                       -- amenities @> $1
CREATE INDEX ix_listings_created ON listings (created_at DESC, id DESC) WHERE deleted_at IS NULL;  -- sort newest
CREATE INDEX ix_listings_area ON listings (area_m2);                                        -- minArea, maxArea

CREATE TABLE listing_images (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  listing_id uuid NOT NULL REFERENCES listings(id),
  object_key varchar(300) NOT NULL UNIQUE,
  sort_order smallint NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ix_listing_images_listing ON listing_images (listing_id, sort_order);  -- v1.2: đọc ảnh theo tin (NFR §1)
```

### 6.1 Migration v1.5 (`1733300000000-listings-location-ids.ts`, chạy sau `1733200000000-create-locations.ts` của `RE.LOCATION`)

1. `ADD COLUMN city_id uuid REFERENCES cities(id), ADD COLUMN district_id uuid REFERENCES districts(id)` (tạm cho phép `NULL`).
2. Ánh xạ theo tên: `UPDATE listings l SET city_id = c.id, district_id = d.id FROM cities c JOIN districts d ON d.city_id = c.id WHERE l.city = c.name AND l.district = d.name`.
3. **Xóa cứng** tin không ánh xạ được (`city_id IS NULL OR district_id IS NULL`, kể cả tin đã xóa mềm): xóa `listing_images` của các tin đó trước (FK), rồi xóa `listings`; `RAISE NOTICE` số tin, số ảnh đã xóa (chốt 2026-11-26). Object trên S3 của ảnh bị xóa nằm lại (như `tech-debt.md` #14). Rental có thể còn đơn trỏ tới tin bị xóa: API nội bộ trả `404 LISTING_NOT_FOUND` cho các đơn đó (chỉ dữ liệu dev).
4. `ALTER COLUMN city_id SET NOT NULL, ALTER COLUMN district_id SET NOT NULL`.
5. `DROP INDEX ix_listings_search`, `DROP COLUMN district, city`, tạo lại `ix_listings_search` trên `district_id` và tạo `ix_listings_city`.

`down`: thêm lại `district`, `city` dạng `varchar(100)`, điền tên qua JOIN (tin đã xóa ở bước 3 không khôi phục), khôi phục `ix_listings_search` cũ, xóa `ix_listings_city`, `city_id`, `district_id`.

Seed `seed:listings` (T2.4) giữ tên trong `seed-listings.data.ts` và ghi `city_id`, `district_id` bằng truy vấn con theo tên (id danh mục khác nhau giữa các môi trường, `RE.LOCATION §1.1`); tên không có trong danh mục → seed báo lỗi, hoàn tác.

## 7. Đã chốt

### 2026-11-16

1. Trường và ràng buộc §1.1; `propertyType` 3 giá trị; danh mục tiện ích cố định 11 mã.
2. `approvalStatus`: `PENDING_REVIEW`, `APPROVED`, `REJECTED`.
3. Sửa nội dung hiển thị hoặc thêm ảnh → duyệt lại; sửa giá, cọc, diện tích, tiện ích → không.
4. Ảnh: jpeg/png/webp, ≤ 5 MB, ≤ 10 ảnh/tin. Tìm kiếm: `pageSize` 20, tối đa 50.

### 2026-11-19 (A duyệt kế hoạch T2.2)

5. Phạm vi T2.2 gồm cả route 6 và 12 (đọc); route 11 và API nội bộ ở T2.3.
6. Duyệt lại khi sửa: bảng ở §1.1; tin `REJECTED` sửa bất kỳ trường hoặc thêm ảnh → `PENDING_REVIEW`.
7. Route 8: key đã có → `200` kèm ảnh đã có; ảnh không hợp lệ → `deleteObject`, lỗi xóa chỉ log.
8. Request/response ở §1.4; route 12 vẫn trả tin `HIDDEN`; route 5 trả `204`.

### 2026-11-20 (A chốt §8)

9. Route 1 bắt buộc `address`, `district`, `city` (tìm kiếm lọc theo quận, FR03); `description` tùy chọn, ≤ 5000 ký tự. Chỉ kiểm ở API; DDL §6 giữ cột cho phép `NULL` (không đổi bảng).
10. Ảnh đã lấy upload-url mà không gọi route 8 nằm lại trên S3, không dọn ở bản này (`tech-debt.md` #14; A chốt 2026-11-19).

### 2026-11-20 (A duyệt kế hoạch T2.3)

11. Route 11 trả `ListingSummaryDto` (§1.4): ảnh bìa qua `LEFT JOIN LATERAL`, `distanceM` khi có `lat/lng`; không `images[]`, `description`.
12. Ngữ nghĩa query ở §1.3: `lat`+`lng` đi cùng nhau; `radiusKm` ∈ (0, 50] chỉ khi có `lat/lng`; có `lat/lng` không `radiusKm` → không lọc bán kính, vẫn có `distanceM` và `sort=distance`; `district` so khớp đúng chuỗi; `amenities` CSV; mặc định loại `HIDDEN`, vẫn trả `HELD`, `DEPOSITED`, `RENTED`.
13. Thêm ba index (§6): GIN `amenities`, `(created_at DESC, id DESC) WHERE deleted_at IS NULL`, `area_m2` (bắt buộc theo `non-functional-standards.md §1`, không ghi nợ kỹ thuật).
14. Đổi trạng thái idempotent (§2.2): đích `AVAILABLE` mà tin đã `AVAILABLE` → `200` với mọi `depositId`; tin thuộc đơn khác → `409 LISTING_INVALID_STATUS` kèm `details`. `heldUntil` không kiểm "tương lai".
15. Test 4 chạy trên **fixture** (tin tọa độ thật ở Hà Nội và ~5.000 tin ngẫu nhiên đã `ANALYZE`), vì seed là T2.4 (phụ thuộc T2.3). T2.4 chạy lại `EXPLAIN` bán kính 2 km trên seed thật (`PHASE-2.md`).

`[cần xác nhận]` thuộc **rental**, không chặn listing: cách rental xử lý `409 LISTING_INVALID_STATUS` khi đích `AVAILABLE` — xem `RE.DEPOSIT_SAGA/API_Spec.md §8` và `implementation/van-de-can-quyet-dinh.md` C20.

## 8. Điểm [cần xác nhận]

v1.5 (người dùng trả lời 2026-11-26, chờ A duyệt ở `implementation/van-de-can-quyet-dinh.md` C25):

1. Đổi hợp đồng công khai (MAJOR): body route 1, 2 và query route 11 dùng `cityId`, `districtId` thay chuỗi `city`, `district`; `listings` bỏ hai cột chuỗi. Đổi hành vi đã merge ở T2.2, T2.3 nên cần A chốt (CLAUDE.md §8 NEVER). Giao diện (repo `real-estate`) phải sửa form tạo/sửa tin và bộ lọc tìm kiếm cùng đợt.
2. ~~Tin có tên không khớp danh mục khi migration~~ — người dùng chốt 2026-11-26: xóa cứng (§6.1 bước 3); `city_id`, `district_id` `NOT NULL`. Thay quyết định 9 cho hai cột này.
