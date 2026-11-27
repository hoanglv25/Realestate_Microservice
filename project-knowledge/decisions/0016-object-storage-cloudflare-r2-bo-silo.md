# ADR-0016: Object storage dùng Cloudflare R2 cho cả dev và production, bỏ container Silo

| | |
|---|---|
| **Trạng thái** | Accepted |
| **Ngày** | 2026-11-26 |
| **Người quyết định** | A (duyệt 2026-11-26) |
| **Liên quan** | Thay ADR-0007 (đã đánh dấu `Superseded`), ADR-0014, `implementation/van-de-can-quyet-dinh.md` C26, `RE.LISTING/API_Spec.md` §1.2 và §5 (`listing-images`), `RE.PAYOUT/API_Spec.md` (`payment-proofs`) |

## Bối cảnh

ADR-0007 chọn Silo (container tương thích S3) cho dev và ghi "Production cần quyết định riêng". Nay cần chốt nơi lưu tệp khi deploy backend lên Render:

- Service trên Render có filesystem tạm: không gắn persistent disk thì tệp mất khi redeploy hoặc restart. Persistent disk chỉ có ở gói trả phí và chỉ một instance dùng được. Chạy Silo trên Render còn phải mở nó ra internet (trình duyệt gọi presigned URL), kèm tài khoản root.
- Khi chạy, chỉ hai service dùng S3: listing (`listing-images`, trình duyệt PUT/GET thẳng qua presigned URL) và payment (`payment-proofs`, backend ghi bằng `putObject`). Identity, rental, gateway tự tắt `StorageModule` khi không có `S3_ENDPOINT`.
- Máy dev không muốn chứa tệp; dự án chưa có người dùng thật nên chưa có dữ liệu cần giữ.

Kiểm chứng 2026-11-26 bằng script tạm `services/listing/scripts/r2-smoke.local.mjs` (AWS SDK như `StorageService`, token R2 quyền *Object Read & Write* trên hai bucket): 11/11 bước PASS gồm `HeadBucket` (health check), presigned PUT có ký `Content-Type`, PUT đổi `Content-Type` bị `403`, CORS preflight và GET cho `http://localhost:3000`, `HeadObject`, presigned GET, `putObject` và xóa ở `payment-proofs`. `CreateBucket` trả `AccessDenied (403)`: service vẫn chạy nhưng mỗi lần khởi động thử 10 lần rồi log lỗi.

## Quyết định

Chúng tôi sẽ:

1. Dùng **Cloudflare R2 qua API S3** cho cả dev và production, một tài khoản, hai bucket riêng tư lớp Standard, không chọn jurisdiction: `listing-images`, `payment-proofs`. Code vẫn chỉ phụ thuộc API S3 như ADR-0007; cấu hình: `S3_ENDPOINT=https://<ACCOUNT_ID>.r2.cloudflarestorage.com`, `S3_REGION=auto`, `S3_FORCE_PATH_STYLE=true`, không đặt `S3_PUBLIC_ENDPOINT`.
2. Bỏ service `s3` (Silo) và volume `s3_data` khỏi `infra/compose/docker-compose.yml`; listing, payment lấy `S3_*` từ `.env` thay vì ghi cứng `http://s3:9000`.
3. Token R2 quyền **Object Read & Write chỉ trên hai bucket**, không dùng quyền Admin. Bucket tạo tay trên dashboard. **Xóa hẳn bước tự tạo bucket lúc khởi động** (`ensureBucket`, `ensureBucketsWithRetry`, `bucketsReady` trong `StorageService`, thay quyết định "mỗi service tự `CreateBucket`" của ADR-0007): sửa `_template-nest` trước rồi chép sang mọi service mang bản sao (ADR-0014). Giữ `S3_BUCKETS` cho health check `HeadBucket` và bước kiểm biến lúc khởi động của listing, payment.
4. CORS bucket `listing-images`: `AllowedMethods` `GET`, `PUT`, `HEAD`; `AllowedHeaders` `Content-Type`; `AllowedOrigins` gồm origin giao diện local và production. `payment-proofs` không cần CORS tới khi trình duyệt đọc thẳng chứng từ.
5. Test infra cần S3: xử lý theo C26.
6. **Trước go-live, reset cùng lúc** database và bucket: xóa dữ liệu `listings`, `listing_images` (listing) và `transfer_receipts` (payment) hoặc tạo database mới, đồng thời làm rỗng hai bucket. Reset một phía sẽ để lại ảnh vỡ hoặc tệp mồ côi.

### Phương án đã loại

| Phương án | Lý do loại |
|---|---|
| Giữ Silo ở dev, R2 chỉ cho production | Hai cấu hình phải duy trì; người dùng chọn bỏ container vì chưa có dữ liệu thật |
| Chạy Silo trên Render | Filesystem tạm; persistent disk trả phí, một instance; phải mở Silo ra internet kèm tài khoản root |
| Cloudinary cho ảnh tin đăng | Không có API S3: phải viết adapter, đổi route 7–8 của listing và giao diện; vẫn cần kho S3 riêng cho `payment-proofs`; quota free tính chung lưu trữ, băng thông và biến đổi ảnh |
| Token Admin Read & Write để giữ `CreateBucket` | Khóa lộ thì xóa được bucket và đổi cấu hình |
| Giữ bước tự tạo bucket, thêm biến tắt `S3_AUTO_CREATE_BUCKETS` (mặc định `true`) | Giữ được hành vi cũ và đường lui về S3 local, nhưng khi đã bỏ Silo thì không môi trường nào bật biến này: thêm cấu hình và nhánh code không dùng. Người dùng chọn xóa hẳn 2026-11-26 |
| Bucket dev riêng (`listing-images-dev`) ngay bây giờ | Tên bucket đang ghi cứng trong code và thiết kế; chưa có dữ liệu thật nên chưa cần. Để lại làm việc cần theo dõi sau go-live |

## Hệ quả

**Tích cực**

- Không lưu tệp trên máy dev hay server; Render không cần persistent disk.
- Không phí băng thông tải ra; mức miễn phí hằng tháng 10 GB lưu trữ, 1 triệu thao tác Class A, 10 triệu Class B (bảng giá Cloudflare, xem 2026-11-26).
- Dev và production cùng một loại kho; bớt một container khi chạy compose.
- Đổi sang dịch vụ S3 khác vẫn chỉ đổi biến `S3_*`.

**Tiêu cực / đánh đổi**

- Muốn quay lại S3 chạy local (Silo, MinIO, Garage) phải tạo bucket bằng tay hoặc viết script, vì service không còn tự tạo.
- Dev và test cần internet và khóa R2; mỗi thành viên phải được cấp khóa (tăng nguy cơ lộ khóa). Không chạy được S3 offline.
- Dữ liệu dev nằm chung bucket với production cho tới khi reset go-live.
- Bật R2 cần phương thức thanh toán; R2 không tự chặn khi vượt mức miễn phí.
- Phụ thuộc nhà cung cấp ngoài (giảm nhờ chỉ dùng API S3).

**Cần theo dõi**

- Dung lượng và số thao tác so với mức miễn phí; Budget alert đặt ở trang Billing.
- Thêm origin giao diện production vào CORS khi deploy frontend.
- Sau go-live, dev không được ghi vào bucket production: khi đó tách bucket dev (tên bucket đọc từ biến môi trường) hoặc tài khoản riêng.
- Tech-debt ảnh tải lên nhưng không xác nhận vẫn nằm lại trên kho (ăn dung lượng).
- Khóa lộ thì thu hồi token ngay và tạo token mới (đã xảy ra một lần 2026-11-26 khi tạo token, đã thu hồi).
