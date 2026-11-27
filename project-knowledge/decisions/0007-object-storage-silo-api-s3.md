# ADR-0007: Object storage cho môi trường dev dùng Silo qua API S3

| | |
|---|---|
| **Trạng thái** | Superseded by ADR-0016 (2026-11-26) |
| **Ngày** | 2026-11-05 |
| **Người quyết định** | Nhóm 5 |
| **Liên quan** | Thay số cũ `docs/adr/ADR-007-object-storage.md` (nội dung giữ nguyên ý) |

## Bối cảnh

Cần lưu ảnh tin đăng, ảnh QR ngân hàng, chứng từ chuyển khoản, giấy tờ người thuê. Kế hoạch dùng MinIO, nhưng tháng 9/2026 image MinIO không còn kéo được ở môi trường dev (`docker manifest inspect` thất bại trên `minio/minio` và `quay.io/minio/minio`).

## Quyết định

Chúng tôi sẽ dùng **Silo** (`docker.io/pgsty/silo`, fork cộng đồng tương thích S3), ghim tag `RELEASE.2026-10-26T00-00-00Z`. Ứng dụng chỉ giao tiếp qua **API S3** (AWS SDK, `S3_FORCE_PATH_STYLE=true`, biến `S3_*`). Không dùng `mc` để tạo bucket: mỗi service tự `CreateBucket` khi khởi động (`StorageModule`).

### Phương án đã loại

| Phương án | Lý do loại |
|---|---|
| MinIO chính thức | Không kéo được image |
| Lưu tệp trong Postgres | Tăng kích thước DB, không có presigned URL |

## Hệ quả

**Tích cực**

- Code không phụ thuộc MinIO/Silo; đổi sang Garage, RustFS chỉ đổi image và biến.

**Tiêu cực / đánh đổi**

- Image của bên thứ ba, độ tin cậy thấp hơn.

**Cần theo dõi**

- Production cần quyết định riêng.
