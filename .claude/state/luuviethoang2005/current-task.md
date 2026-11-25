---
task: T3.5 Vòng đời đơn: bàn giao, nhận phòng, tự giải ngân
created: 2026-11-25
status: in_progress
phase: implementation/PHASE-3.md#T3.5
branch: feature/T3.5-deposit-lifecycle (từ `develop` tại `ef2abb5`, sau PR #30 T3.4b)
---

## Mô tả

Đơn sau khi `PAID` (`RE.DEPOSIT_LIFECYCLE`): máy trạng thái `deposit-state.ts`; route 1–7 (xem đơn, nhận phòng, yêu cầu hoàn, quản trị viên bàn giao + `audit_log`, chủ trọ xác nhận); `withdrawal-eligibility` (gồm đơn `REFUNDED`, BR-15 sửa); `AutoReleaseJob` (BR-13), `DeadlineJob` (nhắc trước 24 giờ), `SagaReconcileJob` (c) gửi lại yêu cầu hoàn; nghe `payment.refunded`, `refund-rejected`, `withdrawal-completed`. Người làm: A cùng Claude. Hạn M2 — 2026-12-04, ước ~10 giờ. Phụ thuộc T3.4 (T3.4a, T3.4b đã tick).

## Thiết kế liên quan

`design/RENTAL/RE.DEPOSIT_LIFECYCLE/` v1.1 (API_Spec §1–8, Component_Class_Design §1–5, Processing_Flow §1–5); `RE.BUSINESS_RULES.md §4` (BR-11, 12, 13, 15, 16, 18, 19), `§5` (bảng chuyển); `RE.DEPOSIT_SAGA` v1.4 (DDL `deposits` đã đủ cột vòng đời, `IntervalJob`, `ListingSyncService`). Hợp đồng **có sẵn, không đổi**: `rental-internal.v1.yaml` (`withdrawal-eligibility`), `payment-internal.v1.yaml` (`createRefundRequest`), sự kiện `rental.deposit-handed-over`, `rental.deposit-released`, `rental.release-reminder`, `payment.refunded`, `payment.refund-rejected`, `payment.withdrawal-completed`; binding `rental.payment-events` đã có 4 khóa. Gateway đã định tuyến `/api/v1/deposits/*` (user), `/api/v1/admin/deposits/*` (admin). Thiết kế không còn `[cần xác nhận]`.

**Lưu ý phụ thuộc T3.6:** payment **chưa có** `POST /internal/refund-requests` và chưa phát `payment.refunded`/`refund-rejected`/`withdrawal-completed` (T3.6). T3.5 test các đường này bằng payment giả và handler; chạy thật đầu-cuối nhánh hoàn tiền ở T3.6.

## Definition of Done

- [x] Test 1–16 (gồm 13a, 14a, 14b) ở `RE.DEPOSIT_LIFECYCLE/Component_Class_Design.md §5` pass — unit (1: 360 tổ hợp; 2–4, 6–11, 13–15) + infra `deposit-lifecycle.infra-spec.ts` 21 ca (2–16, E7 ngẫu nhiên + 2 khe đua cố định; gây lỗi thử bỏ `status='PAID'` ở mỗi bên → đỏ) (2026-11-25)
- [x] rental `test` **648/648**, `test:e2e` **97/97** (môi trường Claude); `test:infra` **67/67 trên máy A** (2026-11-25 15:39: deposit-lifecycle 21, saga-compensation 14, rental 18, messaging 8, storage 6)
- [x] `pnpm lint`, `pnpm format:check`, `pnpm build`, `pnpm contracts:check` không lỗi (2026-11-25)
- [x] Số truy vấn đếm bằng log SQL: route 2 = 1, 7 = 2, 4 = 3, 3 = 4, 6 = 4, 1/5 ≤ 2 (TypeORM bỏ câu count khi trang đầu ít hơn `pageSize`), `withdrawal-eligibility` = 1 — trong ngưỡng
- [x] Kiểm chứng (`PHASE-3.md`, máy A, compose, 2026-11-25): `AUTO_RELEASE_SECONDS=120`, `RELEASE_REMINDER_SECONDS=60`; đơn `46f3767a…` tin 22 `PAID` 08:35:50Z (webhook giả, `orderCode` 100003) → `rental.release-reminder` 08:36:55Z (5 giây sau khi vào cửa sổ nhắc) → `RELEASED` trigger `AUTO` 08:37:55Z (5 giây sau `auto_release_at`), tin `RENTED`, đã đồng bộ (E6). Migration T3.5 áp vào DB compose sau đó bằng `DATABASE_URL` tạm dựng từ `.env` gốc (`services/rental/.env` không có → lần đầu nối cổng 5432): `DepositLifecycle1736000000000` OK
- [x] `RE.DEPOSIT_LIFECYCLE` v1.2 + `CHANGELOG.md`; walkthrough rental, `CLAUDE.md §2.5`; `.env.example` (gốc, rental), compose

## Các bước thực hiện (tổng quan)

- [x] 1. Đọc context, đối chiếu thiết kế (2026-11-25)
- [x] 2. Quét tái sử dụng + kế hoạch chi tiết — A duyệt cả B1–B10 (2026-11-25 14:58)
- [x] 3. Thiết kế v1.2 (chi tiết B1–B10) trước code (2026-11-25)
- [x] 4. Migration `audit_log` + index; entity (thêm cột vòng đời); env (TDD 13/13)
- [x] 5. TDD: `deposit-state.ts` (374), `DepositQueryService` (12), `DepositLifecycleService` (43), `PaymentClient.createRefund`, 3 controller
- [x] 6. TDD: handler 3 sự kiện (11), `AutoReleaseJob` (5), `DeadlineJob` (5), `SagaReconcileJob` (c) (3; test cũ "bỏ lượt chồng" thêm một lần `release` cho lượt `find` thứ ba)
- [x] 7. Test hạ tầng (gồm E7 đồng thời + khe đua cố định), đếm truy vấn
- [x] 8. Walkthrough, `code-review` 5 chiều, commit (không dòng ghi công); `test:infra` 67/67 và kiểm chứng E6 trên máy A (2026-11-25) — còn push, PR

## Tái sử dụng

> Quét 2026-11-25 · Nguồn: `services/rental/src`, `services/rental/test`, `services/_template-nest/src`, `services/listing/src`, `services/payment/src` (phát hiện trùng), `contracts/`, `infra/rabbitmq/definitions.json`, `services/api-gateway/src/gateway/routes.ts` · Cách tra: grep `Paginated|PageQueryDto|Idempotent|Roles|Public|ApiExcludeController|createUuidParamPipe|audit|IntervalJob|push(|classifyCall|createRefund|refund|withdraw|allowedActions|canTransition`; đọc `viewing.service.ts` (mẫu chuyển trạng thái), `payment-events.handler.ts`, `listings.internal.controller.ts` (mẫu route nội bộ), `saga-reconcile.job.ts`, `hold-expiry.job.ts`, `test/helpers/http-upstream.ts`
> Vùng mù: không

| Thành phần cần | Nhóm | Vị trí đã có / lý do viết mới |
|---|---|---|
| Phân trang route 1, 5 | DÙNG LẠI | `src/common/response/page-query.dto.ts#PageQueryDto`, `response-meta.ts#Paginated` (như `ViewingService.findMine`) |
| `Idempotency-Key` route 4 | DÙNG LẠI | `src/common/idempotency/idempotent.decorator.ts#Idempotent` |
| Quyền, người gọi | DÙNG LẠI | `@Roles`, `@CurrentUser`, `@Public` + `@ApiExcludeController` cho route nội bộ (như `listings.internal.controller.ts`) |
| `:id` UUID | DÙNG LẠI | `src/common/errors/uuid-param.pipe.ts#createUuidParamPipe` |
| Mã lỗi `RENTAL_INVALID_TRANSITION`, `DEPOSIT_NOT_FOUND`, `notRelated` (403) | DÙNG LẠI | `src/rental/errors/rental.errors.ts` |
| Mã lỗi `RENTAL_REFUND_WINDOW_CLOSED`, `RENTAL_REFUND_PENDING`, `RENTAL_NOT_HANDED_OVER` | MỞ RỘNG | thêm vào `rental.errors.ts` (đã có trong catalog `API_Spec §5`) |
| Gọi payment tạo yêu cầu hoàn | MỞ RỘNG | `src/rental/clients/payment.client.ts#PaymentClient`: thêm `createRefund({depositId})` (`idempotent: true`, như `cancelOrder`) |
| Đẩy `RENTED`/`AVAILABLE` sang listing | DÙNG LẠI | `src/rental/services/listing-sync.service.ts#push`; lỗi tạm → `SagaReconcileJob` (b) |
| Phân loại lỗi lời gọi | DÙNG LẠI | `src/rental/clients/call-outcome.ts#classifyCall`, `saga-log.ts#errorDetail` |
| Outbox trong transaction | DÙNG LẠI | `src/messaging/outbox.service.ts#OutboxService.add` |
| Đăng ký handler sự kiện | MỞ RỘNG | `src/rental/events/payment-events.handler.ts`: thêm 3 sự kiện (`EventHandlerRegistry.on`) |
| Khung job định kỳ | DÙNG LẠI | `src/rental/jobs/interval-job.ts#IntervalJob` (T3.4b) |
| Job (c) gửi lại yêu cầu hoàn | MỞ RỘNG | `src/rental/jobs/saga-reconcile.job.ts`: thêm phần (c) (thiết kế §1 đặt ở đây) |
| Entity `deposits` thiếu cột vòng đời | MỞ RỘNG | `src/rental/entities/deposit.entity.ts`: thêm cột đã có trong DDL (`release_reminded_at`, `admin_confirmed_at/by`, `seller_acknowledged_at`, `released_at`, `release_trigger`, `refunded_at`, `withdrawn_at`, `refund_synced_at`) |
| Máy chủ listing/payment giả cho infra | VIẾT MỚI (trong spec mới) | `test/helpers/http-upstream.ts` là upstream cố định của template (e2e), không đổi hành vi theo test được; dựng như `saga-compensation.infra-spec.ts` |
| `domain/deposit-state.ts`, `DepositQueryService`, `DepositLifecycleService`, `AuditLog` entity, 2 controller (admin, nội bộ), `AutoReleaseJob`, `DeadlineJob`, DTO đơn | VIẾT MỚI | Nghiệp vụ rental (`Component_Class_Design §1`); grep `canTransition|allowedActions|audit_log|AutoRelease|Deadline` trong `services/rental/src`: chưa có. `audit_log` của payment (T3.6) chưa có và không được import chéo |

## Kế hoạch chi tiết

> **A duyệt cả B1–B10 (2026-11-25 14:58).** TDD bật (`warn`): mỗi hành vi RED → GREEN → REFACTOR.

### A. Phạm vi

| Có trong T3.5 | Để sau / không làm |
|---|---|
| `deposit-state.ts` (bảng `RE.BUSINESS_RULES §5`), route 1–7, `withdrawal-eligibility` | Route payment `POST /internal/refund-requests`, phát `payment.refunded`… (T3.6) |
| `audit_log` HAND_OVER (B12), migration | Giao diện (repo Next.js riêng) |
| `AutoReleaseJob`, `DeadlineJob`, `SagaReconcileJob` (c) | Thông báo cho người dùng (notification, T4.x) |
| Handler `payment.refunded`, `payment.refund-rejected`, `payment.withdrawal-completed` | |

### B. Điểm cần A quyết (đề xuất)

| # | Chỗ | Đề xuất |
|---|---|---|
| 1 | `allowedActions` (route 1, 2) và nội dung đơn trả về — thiết kế chưa liệt kê | `allowedActions` ∈ `CONFIRM_MOVE_IN` (người thuê, `PAID`), `REQUEST_REFUND` (người thuê, `PAID`, còn trong `refund_deadline_at`), `ACKNOWLEDGE` (chủ trọ, đã bàn giao, chưa xác nhận), `HAND_OVER` (admin, `PAID`/`RELEASED`, chưa bàn giao). `DepositDto`: id, listingId, listingTitle, tenantId, ownerId, amountVnd, status, paidAt, refundDeadlineAt, autoReleaseAt, adminConfirmedAt, sellerAcknowledgedAt, releasedAt, releaseTrigger, refundedAt, withdrawnAt, createdAt, allowedActions; `checkoutUrl`, `qrCode`, `expiresAt` **chỉ** cho người thuê khi `PENDING_PAYMENT` |
| 2 | Chủ trọ xem chi tiết đơn (route 2) — "sau khi xác nhận bàn giao" | Chủ tin xem được khi **quản trị viên đã bàn giao** (`admin_confirmed_at`) hoặc đơn `REFUNDED`; nếu không thì `403`. Lý do: chủ trọ phải mở được đơn để bấm xác nhận (route 7). **Danh sách** (route 1) vẫn chỉ có đơn đã xác nhận hoặc `REFUNDED` (BR-11, test 12, 14b) |
| 3 | Route 5 (admin) lọc | Không truyền `status` → `PAID` chưa bàn giao (theo thiết kế); có `status` → mọi đơn trạng thái đó; phân trang `page/pageSize`, `ORDER BY created_at DESC, id DESC` |
| 4 | Gửi yêu cầu hoàn sang payment lỗi | Đơn vẫn `REFUND_REQUESTED` (người thuê nhận `200`); job (c) mỗi 15 giây gửi lại **mọi** loại lỗi (kể cả 4xx), log `warn`; thành công → `refund_synced_at`. Không có kết cục cuối vì yêu cầu hoàn bắt buộc phải tới quản trị viên (BR-12). Hệ quả tới khi T3.6 xong: payment chưa có route → job log `warn` mỗi lượt cho đơn đã yêu cầu hoàn |
| 5 | Đồng bộ tin sau `RELEASED`/`REFUNDED` | Nhận phòng và `AutoReleaseJob`: đẩy `RENTED` ngay sau commit (lỗi → job (b)). `payment.refunded`: chỉ đặt đích `AVAILABLE` trong transaction, job (b) đẩy (handler không gọi HTTP, như `payment.deposited`) |
| 6 | `DeadlineJob` | Chọn `PAID`, `release_reminded_at IS NULL`, `auto_release_at - RELEASE_REMINDER_SECONDS <= now() < auto_release_at`; transaction `UPDATE release_reminded_at = now() WHERE ... IS NULL` + outbox `rental.release-reminder` → đúng một sự kiện mỗi đơn (test 15) |
| 7 | Biến môi trường mới | `RELEASE_REMINDER_SECONDS` (86400), `AUTO_RELEASE_INTERVAL_MS` (10000), `DEADLINE_INTERVAL_MS` (10000); `0` tắt lịch như hai job trước. Có ở `.env.example` gốc, rental, compose |
| 8 | Migration mới: `audit_log` (DDL `API_Spec §7`) **và 2 index** chưa có trong thiết kế | `ix_deposits_status_created (status, created_at DESC)` cho route 5 lọc theo trạng thái (`non-functional-standards §1`: MUST index cột lọc của API danh sách); `ix_deposits_refund_sync (updated_at) WHERE status='REFUND_REQUESTED' AND refund_synced_at IS NULL` cho job (c) |
| 9 | Sự kiện đến khi đơn không ở trạng thái chờ | `UPDATE ... WHERE status=<từ>` 0 dòng → bỏ qua, log `warn` (Processing_Flow §4 "sai thứ tự"). `payment.refunded` `SYSTEM` → bỏ qua, log `info`. `withdrawal-completed` đơn `REFUNDED` → chỉ `withdrawn_at` (nếu còn trống) |
| 10 | `audit_log` HAND_OVER | `actor_id` = admin, `before {status, adminConfirmedAt: null}`, `after {status, adminConfirmedAt, adminConfirmedBy}`, `correlation_id`; lần bàn giao lặp lại không ghi (test 14a) |

### C. Số truy vấn (ước, ngưỡng `non-functional-standards §1`)

| Route / việc | Ước | Ngưỡng |
|---|---|---|
| 1 `GET /deposits/mine` | 2 (count + data) | đọc danh sách 4 |
| 2 `GET /deposits/:id` | 1 | đọc chi tiết 3 |
| 3 nhận phòng | 4: đọc đơn, transaction `UPDATE ... RETURNING` + outbox, đánh dấu đã đẩy `RENTED` | ghi 6 |
| 4 yêu cầu hoàn | 4: đọc đơn, `UPDATE` có điều kiện, đánh dấu `refund_synced_at`, đọc lại | ghi 6 |
| 5 admin danh sách | 2 | đọc danh sách 4 |
| 6 bàn giao | 4: đọc đơn, transaction `UPDATE ... RETURNING` + `audit_log` + outbox | ghi 6 |
| 7 chủ trọ xác nhận | 2: đọc đơn, `UPDATE ... RETURNING` | ghi 6 |
| `withdrawal-eligibility` | 1 | đọc chi tiết 3 |
| Handler (trong transaction inbox) | 1 `UPDATE` mỗi sự kiện | |
| `AutoReleaseJob` | 1 `SELECT`/lượt; mỗi đơn 2 (transaction) + 1 (đánh dấu) | ghi 6 |
| `DeadlineJob` | 1 `SELECT`/lượt; mỗi đơn 2 | ghi 6 |
| Job (c) | 1 `SELECT`/lượt; mỗi đơn 1 | ghi 6 |

### D. File

| File | Việc |
|---|---|
| `project-knowledge/design/RENTAL/RE.DEPOSIT_LIFECYCLE/{API_Spec,Component_Class_Design,Processing_Flow,CHANGELOG}.md` | v1.2: B1–B10 |
| `services/rental/src/database/migrations/1736000000000-deposit-lifecycle.ts` | MỚI: `audit_log` + 2 index (B8), có `down` |
| `services/rental/src/config/env.validation.ts` (+ spec), `.env.example` gốc, `services/rental/.env.example`, `infra/compose/docker-compose.yml`, `test/setup-infra-env.ts` | Biến B7 |
| `src/rental/entities/deposit.entity.ts`, `entities/audit-log.entity.ts` (mới) | Cột vòng đời; `AuditLog` |
| `src/rental/domain/deposit-state.ts` (+ spec) | MỚI: `canTransition`, `allowedActions` |
| `src/rental/errors/rental.errors.ts` | 3 mã lỗi |
| `src/rental/clients/payment.client.ts` (+ `clients.spec.ts`) | `createRefund` |
| `src/rental/dto/deposit.dto.ts` | `DepositDto`, query route 1, 5, `WithdrawalEligibilityDto` |
| `src/rental/services/deposit-query.service.ts` (+ spec) | MỚI: route 1, 2, 5 |
| `src/rental/services/deposit-lifecycle.service.ts` (+ spec) | MỚI: route 3, 4, 6, 7, eligibility |
| `src/rental/controllers/deposits.controller.ts` | Route 1, 2, 3, 4, 7 |
| `src/rental/controllers/deposits.admin.controller.ts`, `deposits.internal.controller.ts` | MỚI: route 5, 6; `withdrawal-eligibility` |
| `src/rental/events/payment-events.handler.ts` (+ spec) | 3 sự kiện |
| `src/rental/jobs/auto-release.job.ts`, `deadline.job.ts` (+ spec), `saga-reconcile.job.ts` (+ spec) | MỚI ×2; (c) |
| `src/rental/rental.module.ts` | Đăng ký |
| `services/rental/test/deposit-lifecycle.infra-spec.ts` | MỚI |
| `project-knowledge/guides/RE_Rental_Code_Walkthrough.md`, `project-knowledge/CLAUDE.md §2.5` | Cập nhật |

### E. Test

| Tầng | Test |
|---|---|
| `test` | 1 (`deposit-state.spec.ts`: mọi cặp trong và ngoài bảng; `allowedActions`); 2, 3, 4 (lifecycle service, payment giả); 6, 7, 8, 14 (handler); 9, 10, 11; 13, 13a; 15 (`DeadlineJob`); `AutoReleaseJob`; job (c) |
| `test:infra` (`deposit-lifecycle.infra-spec.ts`, Postgres + Redis thật, listing/payment giả) | 2, 3, 4 (payment lỗi → `200`, job (c) gửi lại), **5 (E7: yêu cầu hoàn đồng thời `AutoReleaseJob`, một trạng thái cuối)**, 6–8, 14 qua handler thật, 9 (`RENTED` đã đẩy), 10, 11, 12, 13/13a qua route nội bộ, 14a (`audit_log`), 14b, 15, 16 (`403`); đếm truy vấn mỗi route; sự kiện phát ra khớp `contracts/events` |

### F. Kiểm chứng (máy A, compose)

`AUTO_RELEASE_SECONDS` rút ngắn (ví dụ 90), `RELEASE_REMINDER_SECONDS` 30: đơn `PAID` (đặt cọc + webhook giả có chữ ký) → sau ~60 giây có `rental.release-reminder`, sau ~90 giây `RELEASED` trigger `AUTO`, tin `RENTED` (E6).

### G. Thứ tự

Thiết kế v1.2 → migration + entity + env → `deposit-state` (TDD) → query service + route 1, 2, 5 → lifecycle service + route 3, 4, 6, 7, nội bộ → handler → `AutoReleaseJob`, `DeadlineJob`, job (c) → module → infra-spec → lint/format/build/contracts → kiểm chứng (A) → walkthrough → `code-review` → commit, PR.

## Blockers / Ghi chú

- **code-review 5 chiều (2026-11-25):** không CRITICAL/MAJOR. MINOR: spec infra truy cập field private để dựng khe đua cố định (chỉ trong test); `refunded_at`/`withdrawn_at` lấy theo `occurredAt` (payload không có thời điểm riêng, ghi hạn chế).

- Chạy test: máy ảo trên máy A không đọc được `node_modules` (junction pnpm) → Claude chạy test trong bản sao riêng, chép code về (như T3.4b); `test:infra` đủ chạy trên máy A.
