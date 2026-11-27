# Kiến thức dự án Real-estate — Cổng vào

> Ngữ cảnh đặc thù của dự án. `CLAUDE.md` gốc trỏ tới file này; quy trình và MUST/NEVER nằm ở `CLAUDE.md` gốc.
> Mọi đường dẫn tính từ `project-knowledge/`. Chỉ mục cho người đọc: `README.md`.

> [!IMPORTANT]
> `@path` = nạp vào **mọi phiên** (tốn token, dễ loãng). Chỉ `@` file cần ở hầu hết mọi phiên.
> Tài liệu theo tình huống → liệt kê ở §2, Claude tự đọc khi cần. Phân vân → để ở §2.

> [!NOTE]
> Procedure, skill, hook nằm ở `.claude/` (định tuyến: `.claude/AGENTS.md`). Quy trình và MUST/NEVER ở `CLAUDE.md` gốc của repo.

| | |
|---|---|
| **Chủ sở hữu / Cập nhật** | hoang.lv — 2026-11-12 |

## 1. Nạp mọi phiên

@./architecture.md
@./domain-glossary.md

---

## 2. Tham chiếu — đọc khi cần

> Mục lục điều hướng. Chi tiết nằm trong file được trỏ tới, **không chép lại ở đây**.

### 2.1 Bản đồ nhanh

| Tình huống | Đọc |
|---|---|
| Mới vào dự án, muốn biết làm gì tiếp | `implementation/README.md` → `implementation/progress.md` |
| Đọc thiết kế lần đầu, chuyển thiết kế thành code | `guides/RE_Design_Reading_Guide.md` |
| Toàn cảnh dữ liệu 5 database | `data-model.md` |
| **Thiết kế** chức năng (procedure `solution-architect`) | §2.2 nghiệp vụ → §2.3 thiết kế liên quan → `standards/design-standards.md` |
| **Code** chức năng (procedure `developer`) | Task trong `implementation/` (§2.6) → thiết kế `design/<CỤM>/<MÃ>/` (§2.3) — **MUST bám** |
| Gặp `[cần xác nhận]`, hoặc các nguồn lệch nhau | `implementation/van-de-can-quyet-dinh.md`; Báo cáo v2 là chuẩn |
| Đặt file ở đâu, cây thư mục toàn dự án | `project-structure.md` |
| Ai làm phần nào | `implementation/README.md §2` |
| Đề bài yêu cầu gì, đáp ứng ở đâu | `requirements-traceability.md` |
| Tạo service mới | `services/_template-nest/README.md §1` + `design/SHARED/RE.SERVICE_TEMPLATE/` |
| Gọi service khác | `design/SHARED/RE.SERVICE_TEMPLATE/API_Spec.md §3` + `standards/reliability-standard.md` |
| Phát hoặc nhận sự kiện | `design/SHARED/RE.MESSAGING/` + `contracts/events/` |
| Sửa luồng đặt cọc | `design/RENTAL/RE.DEPOSIT_SAGA/` |
| Sửa tiền: webhook, hoàn, rút, ví | `design/PAYMENT/` |
| Chạy hệ thống, gỡ lỗi Docker | `guides/RE_Docker_Local_Guide.md` |
| OpenAPI, Postman, CI | `guides/RE_OpenAPI_Postman_Guide.md` |
| Làm thí nghiệm lỗi | `guides/RE_Failure_Experiment_Guide.md` |
| Viết báo cáo, slide, vấn đáp | `guides/RE_Report_Defense_Guide.md` |
| Vì sao quyết định như vậy | `decisions/README.md` |
| Thêm tài liệu thiết kế mới | `standards/design-standards.md` + `design/_template/` |
| Playbook đang bật (TDD) | `playbooks/README.md` |

### 2.2 Đặc tả nghiệp vụ — nguồn sự thật về nghiệp vụ

| Đường dẫn | Đọc khi |
|---|---|
| `business-spec/RE.BUSINESS_RULES.md` | Thiết kế hoặc code bất kỳ chức năng nào: tác nhân, use case, `BR-01`–`BR-19`, máy trạng thái đơn đặt cọc |
| `business-spec/RE.SRS.md` | Cần yêu cầu chức năng FR, user story và tiêu chí chấp nhận, đặc tả use case chi tiết, giao diện ngoài |
| `business-spec/README.md` | Thêm hoặc sửa quy tắc; thứ tự ưu tiên nguồn |

### 2.3 Thiết kế kỹ thuật

> Quy trình và vòng đời: `design/README.md`. Chuẩn viết: `standards/design-standards.md`.
> Thêm chức năng → thêm một cụm `####` theo mẫu dưới. `CHANGELOG.md` chỉ có từ lần sửa đầu tiên sau v1.0.

#### RE.SERVICE_TEMPLATE — Khung kỹ thuật dùng chung (`services/_template-nest`)

| Đường dẫn | Đọc khi |
|---|---|
| `design/SHARED/RE.SERVICE_TEMPLATE/API_Spec.md` | Dùng `/health`, envelope, mã lỗi chung, `InternalHttpService`, decorator, biến môi trường |
| `design/SHARED/RE.SERVICE_TEMPLATE/Component_Class_Design.md` | Tạo service mới, sửa phần dùng chung, test có sẵn |
| `design/SHARED/RE.SERVICE_TEMPLATE/Processing_Flow.md` | Cần vòng đời request, retry, idempotency |

#### RE.GATEWAY — API Gateway (`api-gateway`, A)

| Đường dẫn | Đọc khi |
|---|---|
| `design/SHARED/RE.GATEWAY/API_Spec.md` | Thêm hoặc đổi route — bảng định tuyến, mức truy cập, mã lỗi gateway |
| `design/SHARED/RE.GATEWAY/Component_Class_Design.md` | Code gateway — thứ tự middleware, `routes.ts`, test |
| `design/SHARED/RE.GATEWAY/Processing_Flow.md` | Cần luồng request, webhook, service đích lỗi |

#### RE.MESSAGING — RabbitMQ, outbox, consumer chống trùng, DLQ, danh mục sự kiện

| Đường dẫn | Đọc khi |
|---|---|
| `design/SHARED/RE.MESSAGING/API_Spec.md` | Phát hoặc nhận sự kiện — topology, phong bì, danh mục sự kiện, DDL |
| `design/SHARED/RE.MESSAGING/Component_Class_Design.md` | Code `OutboxService`, handler, thay đổi `definitions.json` |
| `design/SHARED/RE.MESSAGING/Processing_Flow.md` | Cần luồng phát, nhận, thử lại, DLQ |

#### RE.IDENTITY — Tài khoản, phiên, tài khoản nhận tiền (`identity`, A)

| Đường dẫn | Đọc khi |
|---|---|
| `design/IDENTITY/RE.IDENTITY/API_Spec.md` | Làm route auth (đã có), tài khoản ngân hàng, đổi vai trò, API nội bộ, mã lỗi `IDENTITY_*` |
| `design/IDENTITY/RE.IDENTITY/Component_Class_Design.md` | Code identity — cấu trúc, store refresh token, test |
| `design/IDENTITY/RE.IDENTITY/Processing_Flow.md` | Cần luồng đăng ký, đăng nhập, xoay vòng token |

#### RE.LISTING — Sản phẩm, duyệt, ảnh, tìm kiếm, giữ chỗ (`listing`, B)

| Đường dẫn | Đọc khi |
|---|---|
| `design/LISTING/RE.LISTING/API_Spec.md` | Làm route công khai, API nội bộ giữ chỗ/đổi trạng thái, mã lỗi `LISTING_*`, DDL PostGIS |
| `design/LISTING/RE.LISTING/Component_Class_Design.md` | Code listing — `ListingHoldService`, test đồng thời |
| `design/LISTING/RE.LISTING/Processing_Flow.md` | Cần vòng đời trạng thái BĐS, tải ảnh, hai người cùng giữ chỗ |

#### RE.LOCATION — Danh mục tỉnh/thành, quận/huyện (module của listing; đề xuất 2026-11-26, chờ A)

| Đường dẫn | Đọc khi |
|---|---|
| `design/LISTING/RE.LOCATION/API_Spec.md` | Làm route `cities`, `districts`, DDL và dữ liệu 5 tỉnh, kiểm cặp `cityId`/`districtId` |
| `design/LISTING/RE.LOCATION/Component_Class_Design.md` | Code `LocationQueryService`, `LocationsController`, test danh mục |
| `design/LISTING/RE.LOCATION/Processing_Flow.md` | Cần luồng form chọn tỉnh → quận → tạo tin, số truy vấn |

#### RE.VIEWING — Lịch xem nhà (module của rental, C)

| Đường dẫn | Đọc khi |
|---|---|
| `design/RENTAL/RE.VIEWING/API_Spec.md` | Làm route lịch xem |
| `design/RENTAL/RE.VIEWING/Component_Class_Design.md` | Code `ViewingService` |
| `design/RENTAL/RE.VIEWING/Processing_Flow.md` | Cần luồng đặt lịch, từ chối, hủy, tự hủy khi có người cọc, xác nhận đã xem |

#### RE.DEPOSIT_SAGA — Saga đặt cọc, bù trừ, hết hạn, đối soát (module của rental, C)

| Đường dẫn | Đọc khi |
|---|---|
| `design/RENTAL/RE.DEPOSIT_SAGA/API_Spec.md` | Làm `POST /deposits` — thứ tự bước, lời gọi ra ngoài, DDL `rental_db` |
| `design/RENTAL/RE.DEPOSIT_SAGA/Component_Class_Design.md` | Code saga — `start`, `CompensationService`, job, handler `payment.deposited`, test bắt buộc |
| `design/RENTAL/RE.DEPOSIT_SAGA/Processing_Flow.md` | Cần luồng thành công, ba lớp chặn, bảng xử lý từng điểm lỗi, bất biến |

#### RE.DEPOSIT_LIFECYCLE — Bàn giao, nhận phòng, yêu cầu hoàn, tự giải ngân (module của rental, C)

| Đường dẫn | Đọc khi |
|---|---|
| `design/RENTAL/RE.DEPOSIT_LIFECYCLE/API_Spec.md` | Làm route vòng đời đơn, API nội bộ điều kiện rút, mã lỗi `RENTAL_*` |
| `design/RENTAL/RE.DEPOSIT_LIFECYCLE/Component_Class_Design.md` | Code `DepositLifecycleService`, `AutoReleaseJob`, `deposit-state.ts` |
| `design/RENTAL/RE.DEPOSIT_LIFECYCLE/Processing_Flow.md` | Cần luồng bàn giao, hoàn tiền, đua với tự giải ngân |

#### RE.PAYMENT — Payment order, payOS, webhook, tiền đến muộn (`payment`, C)

| Đường dẫn | Đọc khi |
|---|---|
| `design/PAYMENT/RE.PAYMENT/API_Spec.md` | Làm webhook, API nội bộ payment order, mã lỗi `PAYMENT_*`, DDL |
| `design/PAYMENT/RE.PAYMENT/Component_Class_Design.md` | Code `WebhookService`, `PayosClient` |
| `design/PAYMENT/RE.PAYMENT/Processing_Flow.md` | Cần luồng tạo link, webhook, đua với hủy link |

#### RE.PAYOUT — Ví trung gian, hoàn, rút, chứng từ (module của payment, C)

| Đường dẫn | Đọc khi |
|---|---|
| `design/PAYMENT/RE.PAYOUT/API_Spec.md` | Làm route ví/hoàn/rút, API nội bộ yêu cầu hoàn, DDL ví |
| `design/PAYMENT/RE.PAYOUT/Component_Class_Design.md` | Code `WalletService`, `WithdrawalService`, `RefundService` |
| `design/PAYMENT/RE.PAYOUT/Processing_Flow.md` | Cần luồng rút, hoàn, bất biến ví |

#### RE.NOTIFICATION — Thông báo từ sự kiện (`notification`, A)

| Đường dẫn | Đọc khi |
|---|---|
| `design/NOTIFICATION/RE.NOTIFICATION/API_Spec.md` | Làm route thông báo, danh sách sự kiện → thông báo, mã lỗi `NOTIFICATION_*` |
| `design/NOTIFICATION/RE.NOTIFICATION/Component_Class_Design.md` | Code consumer, `message-templates.ts` |
| `design/NOTIFICATION/RE.NOTIFICATION/Processing_Flow.md` | Cần luồng sự kiện → thông báo, khi phụ thuộc lỗi |

#### RE.CHAT — Nhắn tin, kênh hỗ trợ, WebSocket (module của notification, A)

| Đường dẫn | Đọc khi |
|---|---|
| `design/NOTIFICATION/RE.CHAT/API_Spec.md` | Làm route hội thoại, Socket.IO |
| `design/NOTIFICATION/RE.CHAT/Component_Class_Design.md` | Code `MessageService`, `RealtimeGateway` |
| `design/NOTIFICATION/RE.CHAT/Processing_Flow.md` | Cần luồng gửi tin, kênh hỗ trợ |

### 2.4 Quy chuẩn

| Đường dẫn | Đọc khi |
|---|---|
| `standards/api-convention.md` | Thiết kế hoặc viết API: đường dẫn, status, envelope, mã lỗi, header |
| `standards/coding-convention.md` | Viết code: ranh giới service, cấu trúc module, đặt tên, TypeORM, test |
| `standards/reliability-standard.md` | Viết lời gọi liên service, health check, timeout, retry |
| `standards/non-functional-standards.md` | NFR01–08; API danh sách, truy vấn DB, index |
| `standards/security-policy.md` | Secret, JWT, webhook, phân quyền |
| `standards/design-standards.md` | Viết hoặc review tài liệu thiết kế |
| `standards/git-workflow.md` | Nhánh, commit, PR |
| `standards/gotchas.md` | Cạm bẫy đã gặp — đọc trước khi gỡ lỗi |

### 2.5 Hướng dẫn

| Đường dẫn | Đọc khi |
|---|---|
| `guides/RE_Design_Reading_Guide.md` | Thứ tự đọc thiết kế, ký hiệu, chuyển thiết kế thành code |
| `guides/RE_Docker_Local_Guide.md` | Chạy hệ thống, cổng, seed, payOS + đường hầm, reset |
| `guides/RE_OpenAPI_Postman_Guide.md` | Sinh `openapi.json`, mô tả lỗi, Postman, Newman, CI |
| `guides/RE_Failure_Experiment_Guide.md` | Làm thí nghiệm E1–E10, ghi kết quả |
| `guides/RE_Report_Defense_Guide.md` | Báo cáo, slide, kịch bản demo, vấn đáp |
| `guides/_template_Code_Walkthrough.md` | Viết file giải thích code `RE_<Thành_phần>_Code_Walkthrough.md` sau mỗi task có code (`CLAUDE.md` gốc §8). Mỗi file walkthrough thêm một dòng ở bảng này |
| `guides/RE_Contracts_Code_Walkthrough.md` | Hiểu `contracts/` (4 API nội bộ, 17 sự kiện), topology RabbitMQ, lệnh `contracts:check`; vấn đáp contract-first |
| `guides/RE_Gateway_Code_Walkthrough.md` | Hiểu `services/api-gateway` (bảng định tuyến, kiểm JWT mức tuyến, rate limit, proxy giữ body thô, `/ws`); thêm route hoặc đổi mức truy cập; vấn đáp gateway |
| `guides/RE_Listing_Code_Walkthrough.md` | Hiểu `services/listing` (CRUD sản phẩm bằng `UPDATE ... WHERE`, duyệt, ảnh presigned PUT + `HeadObject`, quy tắc duyệt lại khi sửa, khóa dòng khi đếm ảnh, tìm kiếm PostGIS `ST_DWithin` + bộ dựng SQL, API nội bộ giữ chỗ nguyên tử và đổi trạng thái theo đơn, seed 30 tin Hà Nội; ảnh trên Cloudflare R2, T1.4); thêm bộ lọc hoặc sửa luật giữ chỗ; vấn đáp listing |
| `guides/RE_Identity_Code_Walkthrough.md` | Hiểu `services/identity` (đăng ký + xác minh OTP qua Mailpit, đăng nhập theo trạng thái, quên mật khẩu, Google, khóa tài khoản, `PATCH /users/me`, refresh token xoay vòng và `revokeAllForUser`, tài khoản nhận tiền mã hóa AES-GCM, API nội bộ cho payment, danh sách người dùng, seed 3 chủ trọ và 5 người thuê); vấn đáp identity |
| `guides/RE_Payment_Code_Walkthrough.md` | Hiểu `services/payment` (T3.1: payment order idempotent theo `depositId`, INSERT trước khi gọi payOS, `PayosClient` không retry tạo link, hủy bằng `UPDATE ... WHERE status='PENDING'` đua với webhook, migration ví; T3.4a: webhook payOS kiểm chữ ký, lưu nguyên văn trước, `PAID`/`LATE`/`DUPLICATE` trong một transaction, ví, outbox, script webhook giả; T3.6: ví trừ tiền, yêu cầu hoàn 70%, lệnh rút tính số tiền, chứng từ `sha256` + S3 (Cloudflare R2, T1.4), hai quản trị viên cùng hoàn tất, route 1–14, E10); vấn đáp payment |
| `guides/RE_Rental_Code_Walkthrough.md` | Hiểu `services/rental` (T3.2: saga đặt cọc luồng thành công với khóa Redis theo tin, giữ chỗ trước khi ghi đơn, `saga_log` + `CallOutcome`, `@Idempotent()`; lịch xem 5 route; nghe `payment.deposited` qua `EventConsumer`); T3.3: bù trừ `CompensationService`, `ListingSyncService` (C20), `SagaReconcileJob` (a), (b) với `@nestjs/schedule`); T3.4b: hết hạn giữ chỗ `HoldExpiryJob` (BR-09), khung job `IntervalJob`; T3.5: vòng đời đơn (route 1–7, `withdrawal-eligibility`, `AutoReleaseJob`, `DeadlineJob`, job (c), sự kiện hoàn/rút); vấn đáp saga, vòng đời đơn |

### 2.6 Kế hoạch triển khai

| Đường dẫn | Đọc khi |
|---|---|
| `implementation/README.md` | Lộ trình, phân công A/B/C, quy trình mỗi task, DoD chung, cắt phạm vi |
| `implementation/progress.md` | Biết task nào xong; tick sau khi merge |
| `implementation/van-de-can-quyet-dinh.md` | Điểm chưa chốt, lệch giữa các nguồn, quyết định đã có |
| `implementation/PHASE-0.md` … `PHASE-7.md` | Làm task `T<x.y>`: đọc trước, các bước, lệnh kiểm chứng, DoD |

### 2.7 Quyết định kiến trúc

| Đường dẫn | Đọc khi |
|---|---|
| `decisions/README.md` | Danh sách ADR và trạng thái, vòng đời ADR |
| `decisions/0004-saga-dieu-phoi-tai-rental.md` | Cần lý do saga ở rental, rental giữ mọi đồng hồ |
| `decisions/0009-dat-coc-qua-payos-vi-trung-gian.md` | Cần lý do payOS, ví trung gian, chi tay có chứng từ |

---

## 3. Bảo trì file này

- Chức năng mới → thêm một cụm `####` + bảng ở §2.3. Guide, standard mới → thêm một dòng ở §2.4 hoặc §2.5. Tất cả **không `@`**.
- Chỉ thêm `@` ở §1 khi file thật sự cần ở hầu hết mọi phiên.
- Mỗi dòng chỉ ghi **đường dẫn + khi nào đọc + tóm tắt ngắn**; chi tiết để trong file được trỏ tới.
