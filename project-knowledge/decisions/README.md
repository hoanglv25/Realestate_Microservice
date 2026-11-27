# Architecture Decision Records

| | |
|---|---|
| **Chủ sở hữu / Cập nhật** | hoang.lv — 2026-11-16 |

Ghi lại các quyết định có đánh đổi, theo format Michael Nygard.

## Cách dùng

1. Copy `_template.md` thành `NNNN-tieu-de-kebab-case.md`.
2. `NNNN` tăng dần, không tái sử dụng kể cả khi ADR bị bỏ.
3. `Proposed` → `Accepted` khi cả nhóm chốt. Không sửa ADR đã `Accepted`; muốn đổi thì tạo ADR mới và đánh dấu ADR cũ `Superseded`.
4. Thêm một dòng vào bảng dưới. Trạng thái trong bảng phải khớp trạng thái trong file.

## Phạm vi

- ADR = quyết định có đánh đổi, ảnh hưởng lâu dài hoặc nhiều chức năng: ranh giới service, cơ chế xác thực, chiến lược nhất quán dữ liệu, pattern chính.
- Người tạo: procedure `solution-architect`, trạng thái `Proposed`. Không tự đặt `Accepted`.
- Rà kho ADR (lỗi thời, mồ côi, mâu thuẫn): skill `decisions-relevance`.
- Quyết định nhẹ trong phiên (đặt tên, chọn cách cục bộ) → `.claude/state/<dev-id>/decisions-log.md`, không phải ADR.

## Đánh số lại

Bộ này đánh số từ 0001. Hai ADR cũ ở `docs/adr/` được chuyển vào: `ADR-007-object-storage.md` → **0007**, `ADR-008-drop-mongodb.md` → **0008** (giữ trạng thái `Accepted` và ngày gốc). Các ADR còn lại ghi lại quyết định đã nêu trong Báo cáo v2 (Bảng 3.14, Bảng 4.5) và để `Proposed` cho tới khi nhóm chốt; nhóm chuyển cả 12 sang `Accepted` ngày 2026-11-16 (T0.2). `docs/adr/` và `docs/architecture/service-boundaries.md` bị xóa khỏi repo (quyết định 2026-11-12, B14); `decisions/` là nơi duy nhất ghi quyết định.

## Danh sách

| ADR | Quyết định | Trạng thái |
|---|---|---|
| [0001](0001-chia-nam-service-theo-nang-luc-nghiep-vu.md) | Chia năm service nghiệp vụ và một gateway theo năng lực nghiệp vụ | Accepted |
| [0002](0002-moi-service-mot-database-chung-container.md) | Mỗi service một database, chung một container PostgreSQL | Accepted |
| [0003](0003-gateway-nestjs-xac-thuc-jwt-rs256.md) | Gateway NestJS, xác thực JWT RS256 tại gateway và service | Accepted |
| [0004](0004-saga-dieu-phoi-tai-rental.md) | Saga điều phối tập trung tại rental-service | Accepted |
| [0005](0005-ban-chup-thay-join.md) | Bản chụp dữ liệu thay cho JOIN | Accepted |
| [0006](0006-outbox-rabbitmq-consumer-idempotent.md) | Outbox, RabbitMQ, consumer chống trùng, DLQ | Accepted |
| [0007](0007-object-storage-silo-api-s3.md) | Object storage Silo qua API S3 | Superseded by ADR-0016 |
| [0008](0008-bo-mongodb-notification-dung-postgresql.md) | Bỏ MongoDB, notification dùng PostgreSQL | Accepted |
| [0009](0009-dat-coc-qua-payos-vi-trung-gian.md) | Đặt cọc qua payOS, ví trung gian, chi tay có chứng từ | Accepted |
| [0010](0010-gop-quan-ly-san-pham-vao-listing.md) | Gộp quản lý sản phẩm vào listing | Accepted |
| [0011](0011-khung-response-va-ma-loi.md) | Khung response `{ data, meta }`, mã lỗi `<MIỀN>_<LÝ_DO>` | Accepted |
| [0012](0012-contract-first-cho-api-noi-bo-va-su-kien.md) | Contract-first cho API nội bộ và sự kiện | Accepted |
| [0013](0013-typeorm-migration.md) | Migration TypeORM, tắt `synchronize` | Accepted |
| [0014](0014-template-nestjs-dung-chung.md) | Template NestJS dùng chung, payment bằng NestJS | Accepted |
| [0015](0015-danh-muc-dia-gioi-truoc-2025-tham-chieu-bang-id.md) | Danh mục tỉnh → quận/huyện trước 1/7/2025, tin đăng tham chiếu bằng id | Proposed |
| [0016](0016-object-storage-cloudflare-r2-bo-silo.md) | Object storage Cloudflare R2 cho dev và production, bỏ container Silo | Accepted |
