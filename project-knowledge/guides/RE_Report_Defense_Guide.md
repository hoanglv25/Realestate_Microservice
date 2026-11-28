# Hướng dẫn báo cáo, slide và bảo vệ

> Báo cáo cuối kỳ phát triển từ Báo cáo giữa kỳ v2 (7 chương + phụ lục). Không đổi khung, chỉ thay "dự kiến/chưa đo" bằng kết quả thật.

| | |
|---|---|
| **Chủ sở hữu / Cập nhật** | hoang.lv — 2026-11-12 |

## 1. Dàn ý báo cáo

| Chương | Nội dung | Nguồn | Người viết |
|---|---|---|---|
| 1. Giới thiệu | Bối cảnh, mục tiêu, phạm vi, phương pháp | `business-spec/RE.BUSINESS_RULES.md §1` | A |
| 2. Phân tích yêu cầu | FR, NFR, tác nhân, user story, 19 `BR-xx` | `business-spec/`, `standards/non-functional-standards.md §0` | A |
| 3. Thiết kế hệ thống | Use case, activity, trạng thái, class, sequence, API, hợp đồng sự kiện | `design/`, `contracts/`, `openapi.json` | C (đặt cọc), B (listing), A (còn lại) |
| 4. Kiến trúc và mẫu thiết kế | Sơ đồ một trang, bảng service – dữ liệu – trách nhiệm, tiêu chí phân rã, công nghệ, C4, gateway, độ tin cậy | `architecture.md`, `decisions/`, `standards/reliability-standard.md` | A, C |
| 5. Triển khai và kiểm thử | Môi trường, triển khai, Báo cáo T01–T18, **số liệu E1–E10** | `guides/RE_Docker_Local_Guide.md`, `guides/RE_Failure_Experiment_Guide.md` | B |
| 6. Minh chứng phần mềm | Cấu trúc mã, bằng chứng, demo | `project-structure.md`, ảnh, log | Cả nhóm |
| 7. Kết luận | Đạt, hạn chế, hướng phát triển | §2 dưới | A |
| Phụ lục | Phân công thực tế, truy vết yêu cầu, khai báo AI | `requirements-traceability.md` | A |

Hình thức: mục lục tự động, đánh số hình và bảng, trích dẫn, sơ đồ rõ nét.

## 2. Checklist theo yêu cầu đề

- [ ] Bài toán, đối tượng, ≥ 5 quy tắc (có 19).
- [ ] Sơ đồ kiến trúc đúng một trang (Hình 4.1).
- [ ] Bảng service – dữ liệu – trách nhiệm (Bảng 4.1).
- [ ] Lý do chia và công nghệ (Bảng 4.2–4.4).
- [ ] Mỗi service ≥ 4 endpoint, lỗi `4xx` nghiệp vụ, OpenAPI (đã chốt đường dẫn, bỏ chữ "dự kiến").
- [ ] Gateway không chứa nghiệp vụ.
- [ ] Luồng ≥ 2 service, timeout, retry, dịch vụ dừng hoặc chậm.
- [ ] Dockerfile riêng, chạy một lệnh.
- [ ] Postman ≥ 10 request, ≥ 2 tình huống lỗi có số liệu.
- [ ] Bảng 5.3 không còn "Chưa đo".
- [ ] Phụ lục A cột "Kết quả thực hiện" đã điền; Phụ lục C khai báo AI theo thực tế.

**Hạn chế ghi thật** (Báo cáo v2 Bảng 7.1, cập nhật theo kết quả): chuyển khoản tay, phụ thuộc payOS và đường hầm, giữ chỗ 10 phút, người xem trực tiếp bị người đặt web vượt trước, một container Postgres, một gateway, `/internal` tin mạng Docker, access token không thu hồi được, chưa có circuit breaker (nếu chưa làm X1), image Silo bên thứ ba, queue dự phòng chưa dùng.

Thêm từ quyết định 2026-11-12 (`implementation/van-de-can-quyet-dinh.md` D): **không có hồ sơ người thuê** (Báo cáo §1.3, Bảng 2.3, §3.1, §4.5 có nhắc "nộp hồ sơ"); **mỗi tài khoản một vai trò**, ai vừa thuê vừa cho thuê phải dùng hai email.

**Phần Báo cáo v2 phải sửa ở bản cuối kỳ** (lệch chủ ý đã chốt):

| Chỗ trong Báo cáo v2 | Sửa thành | Quyết định |
|---|---|---|
| Bảng 3.5 identity: `roles`, `user_roles`, `phone` duy nhất | `users.role` một vai trò; `phone` không bắt buộc, duy nhất khi có; thêm `status` | B9 |
| Bảng 3.5 payment: `idempotency_keys` | Bỏ; `Idempotency-Key` lưu Redis | B11 |
| Bảng 3.5 rental | Thêm `audit_log`; cột A8 (`listing_target_status`, `listing_synced_at`, `refund_synced_at`, `release_reminded_at`) | B12, A8 |
| Bảng 3.4, Hình 3.6 | Thêm `PENDING_PAYMENT → CANCELLED` | A1 |
| BR-15 (Bảng 2.5), Bảng 3.3, Hình 3.5 | Thêm: đơn `REFUNDED` do người thuê hủy được rút phần 30%, không cần hai mốc | B13 |
| Bảng 3.13 | Sự kiện của payment thêm `tenantId`, `ownerId` | A5 |
| Bảng 5.1 | `REFUND_WINDOW_SECONDS`, `AUTO_RELEASE_SECONDS`, `RELEASE_REMINDER_SECONDS` | A3 |
| §4.7.1, Bảng 4.6 | Bỏ câu "nhóm cần thống nhất timeout"; ghi giá trị đã chốt và số đo E1, E2 | A2 |
| §1.3, Bảng 2.3, §3.1, §4.5 | Bỏ "nộp hồ sơ người thuê", thêm vào Bảng 7.1 | C3 họp |
| §1.3, §7.3, Bảng 4.4 | Email OTP qua SMTP (dev: Gmail, không còn Mailpit từ C27) và đăng nhập Google đã làm (không còn là hướng phát triển); thêm khóa tài khoản | B10, C2 họp |
| §6.1, tài liệu tham khảo [4], [7] | Trỏ `project-knowledge/architecture.md`, `project-knowledge/decisions/` thay `docs/architecture/service-boundaries.md`, `docs/adr/` (đã xóa) | B14 |
| §3.6–3.7 | Bảng đường dẫn API đã chốt (từ `openapi.json`) | A6 |

## 3. Slide

Số slide `[cần xác nhận]` theo quy định của giảng viên. Gợi ý 10:

| # | Tiêu đề | Nội dung | Người nói |
|---|---|---|---|
| 1 | Real-estate | Đề tài, thành viên | A |
| 2 | Bài toán | Tác nhân, BR-06, BR-07, BR-12, BR-17 | A |
| 3 | Kiến trúc | Sơ đồ, đi theo một request đặt cọc | A |
| 4 | Vì sao 5 service | Tiêu chí phân rã, gộp listing/mobility, tách rental/payment | A |
| 5 | Listing, giữ chỗ nguyên tử | `UPDATE` có điều kiện, PostGIS | B |
| 6 | Saga đặt cọc | Sơ đồ, bù trừ, hết hạn, tiền đến muộn | C |
| 7 | Ví và payOS | Webhook, chống trùng, chứng từ | C |
| 8 | Giao tiếp tin cậy, sự kiện | Timeout, retry, outbox, DLQ | A |
| 9 | Số liệu | E1, E2, E3 | B |
| 10 | Đánh giá | Đạt, hạn chế, phân công | Cả nhóm |

## 4. Kịch bản demo

Theo Báo cáo v2 Bảng 6.2. Mở sẵn: terminal, Postman, RabbitMQ UI, psql, trang payOS thử nghiệm, đường hầm.

### Phần 1: hệ thống chạy

| # | Thao tác | Điểm cần chỉ ra |
|---|---|---|
| 1 | `infra:up`, `infra:check`, khởi động service và đường hầm | Một lệnh; thời gian sẵn sàng |
| 2 | Người thuê đăng nhập, tìm tin theo bán kính, đặt lịch xem | `correlationId` |
| 3 | Đặt cọc, thanh toán payOS thử nghiệm | Đơn `PAID`, BĐS `DEPOSITED`, `DEPOSIT_IN`, thông báo |
| 4 | Admin bàn giao, chủ trọ xác nhận, người thuê nhận phòng | `RELEASED`, `RENTED` |
| 5 | Chủ trọ rút, admin tải chứng từ | `WITHDRAWN`, `WITHDRAW_OUT`, số dư ví |
| 6 | Đơn khác: không thanh toán, `HOLD_TTL_SECONDS=60` | Link hủy; `EXPIRED`; `AVAILABLE` |
| 7 | Đơn khác: yêu cầu hoàn trong 48 giờ | 70%; `REFUNDED` sau chứng từ |

### Phần 2: kịch bản lỗi

| # | Thao tác | Điều phải thấy |
|---|---|---|
| 1 | 50 yêu cầu cùng một căn (E1) | Một `201`, 49 `409` |
| 2 | Tắt listing, đặt cọc (E2) | `503`; xem đơn, thông báo vẫn chạy |
| 3 | Tắt RabbitMQ, thanh toán, bật lại (E3) | Outbox gửi bù; không xử lý trùng |
| 4 | Gửi lại webhook hợp lệ | Ví không đổi |
| 5 | Publish message hỏng | Vào DLQ |

Video dự phòng ≤ 10 phút.

## 5. Vấn đáp

Mỗi người chắc phần mình và trả lời được cơ bản về saga.

### Chung

| Câu hỏi | Ý chính |
|---|---|
| Vì sao 5 service? | Năng lực nghiệp vụ, cụm dữ liệu, mức độ đúng của tiền, 3 người. ADR-0001 |
| Vì sao không tách products-service? | Mất tính nguyên tử của giữ chỗ. ADR-0010 |
| Vì sao rental và payment không gộp? | Saga và bù trừ thể hiện ở đây; tiền cần ràng buộc riêng |
| Hai service đọc chung database được không? | Không: user riêng, `REVOKE CONNECT`. ADR-0002 |
| Nhược điểm so với một ứng dụng? | Mất transaction chung, không JOIN, nhiều lời gọi mạng, vận hành phức tạp |

### A: gateway, identity, notification, sự kiện

| Câu hỏi | Ý chính |
|---|---|
| Vì sao gateway không gọi identity để kiểm token? | RS256, khóa công khai; identity dừng vẫn kiểm được |
| Vì sao service kiểm JWT lần nữa? | Không tin header; template có `JwtAuthGuard` |
| Gateway có kiểm chủ sở hữu không? | Không, service sở hữu dữ liệu kiểm |
| Refresh token bị dùng lại thì sao? | Thu hồi cả họ; Lua script chống đua |
| Vì sao cần outbox? | Lưu và publish không cùng transaction |
| Consumer chống trùng bằng gì? | `processed_events` cùng transaction với handler |
| Khi nào vào DLQ? | Quá 3 lần hoặc `NonRetryableEventError` |
| Notification dừng thì đặt cọc sao? | Vẫn chạy; thông báo đến sau |

### B: listing, kiểm thử

| Câu hỏi | Ý chính |
|---|---|
| Chống hai người giữ cùng căn thế nào? | `UPDATE ... WHERE status='AVAILABLE'`; Postgres khóa dòng; 0 dòng là thua |
| Vì sao còn khóa Redis ở rental? | Chặn bấm lặp sớm, không phải khóa thật |
| Tìm theo bán kính thế nào? | `geography` + `ST_DWithin` + GiST; `EXPLAIN` |
| Vì sao tải ảnh thẳng lên S3? | Không qua service; presigned URL; kiểm kích thước bằng `HeadObject` |
| Đọc số liệu E1, E2 thế nào? | Bằng số thật của nhóm |

### C: rental, payment

| Câu hỏi | Ý chính |
|---|---|
| Vì sao giữ chỗ trước, tạo đơn sau? | Theo báo cáo; giữ chỗ không rõ thì `held_until` tự hết |
| Tạo link lỗi thì sao? | Chưa thực hiện → bù trừ nhả chỗ; chưa biết → đối soát |
| Vì sao hủy link trước khi nhả chỗ? | Không cho trả tiền vào link cũ sau khi chỗ đã cho người khác (BR-09) |
| Tiền đến muộn? | Không phải đặt cọc; `late_payments`, hoàn 100% (BR-10) |
| Webhook trùng? | Unique trên mã giao dịch payOS |
| Webhook và hết hạn cùng lúc? | `UPDATE ... WHERE status='PENDING'` ở payment; một bên thắng |
| Yêu cầu hoàn đúng lúc tự giải ngân? | Cả hai `UPDATE ... WHERE status='PAID'`; một kết cục (BR-18) |
| Ví có thể chi trùng không? | Chứng từ `sha256` duy nhất, `UPDATE` có điều kiện, `Idempotency-Key` |
| Vì sao rental giữ mọi đồng hồ? | Một nơi giữ hạn, tránh lệch (ADR-0004) |
| Vì sao `returnUrl` không đủ? | Client tự mở được; chỉ webhook có chữ ký là bằng chứng |

## 6. Dự phòng

| Sự cố | Phương án |
|---|---|
| Đường hầm hoặc payOS lỗi khi demo | Script giả webhook có chữ ký; video |
| Máy chậm | Dựng trước; không bật profile `demo` |
| Không có mạng | Image đã kéo sẵn; payOS cần mạng → dùng video |
| Demo hỏng giữa chừng | `down -v`, `up`; video |
