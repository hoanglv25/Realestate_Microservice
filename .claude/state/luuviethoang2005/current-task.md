---
task: T3.2 rental: khung, lịch xem, saga luồng thành công
created: 2026-11-21
status: done
phase: implementation/PHASE-3.md#T3.2
branch: feature/T3.2-rental-saga (từ `develop` tại `e231b32`, sau khi T2.5 #25 và T3.1 #26 đã merge)
---

## Mô tả

Tạo `services/rental` từ template (cổng 3003, `rental_db`, Redis, queue `rental.payment-events`); migration `deposits`, `saga_log`, `viewings`; `ViewingService` + 5 route (`RE.VIEWING`); `ListingLock`, `ListingClient`, `PaymentClient`; `DepositSagaService.start` luồng thành công và `POST /deposits` với `@Idempotent()`; `PaymentEventsHandler` cho `payment.deposited` (kèm tự hủy yêu cầu xem `REQUESTED` của người khác). Người làm: A (Claude làm khi A vắng, quyền A trao 2026-11-21). Hạn M2 — 2026-12-04, ước ~16 giờ.

## Thiết kế liên quan

`design/RENTAL/RE.DEPOSIT_SAGA/` v1.2 (`API_Spec §1–§6`, `Component_Class_Design §1–§6, §8`, `Processing_Flow §1–§3, §6`), `design/RENTAL/RE.VIEWING/` v1.1, `RE.DEPOSIT_LIFECYCLE/API_Spec.md §6` (`REFUND_WINDOW_SECONDS`, `AUTO_RELEASE_SECONDS` cho mốc khi `PAID`), ADR-0004, `contracts/openapi/listing-internal.v1.yaml`, `payment-internal.v1.yaml` 1.0.1, `contracts/events/` (`payment.deposited`, `rental.deposit-created`, `rental.viewing-*`). Hợp đồng: **không đổi**.

## Definition of Done

- [x] Test 1, 2, 9, 14, 15, 18 ở `RE.DEPOSIT_SAGA/Component_Class_Design.md §8` pass (thêm 16, giữ chỗ 409, tạo order 504; 2026-11-21)
- [x] Test 1–10 ở `RE.VIEWING/Component_Class_Design.md §3` pass
- [x] rental `test` 158/158, `test:e2e` 97/97, `test:infra`: `rental` 18/18, `messaging` 8/8, `storage` 5/6 (không có S3 thật; template cũng 5/6); mọi sự kiện kiểm bằng `expectEventMatchesContract`
- [x] `pnpm lint`, `format:check`, `build`, `contracts:check` sạch
- [x] Số truy vấn: `POST /deposits` 5, đặt lịch 2, hủy 2, danh sách ≤ 2 (đếm bằng log SQL)
- [x] Walkthrough `guides/RE_Rental_Code_Walkthrough.md` (mới), dòng `CLAUDE.md §2.5`, README, compose, `.env.example`, CI matrix
- [ ] Kiểm chứng qua payOS thử nghiệm thật (PHASE-3): **cần khóa payOS và webhook (T3.4)** → A làm trên máy sau T3.4; Claude đã kiểm bằng listing, payment giả theo hợp đồng + chạy `node dist/main.js` (`/health` db, redis, rabbitmq `up`)

## Các bước thực hiện (tổng quan)

- [x] 1. Đọc context, đối chiếu thiết kế
- [x] 2. Quét tái sử dụng + kế hoạch (Claude tự duyệt 2026-11-21 theo quyền A trao)
- [x] 3. Dựng service từ template, cấu hình, migration, entity
- [x] 4. TDD: `ViewingService` + controller (5 route, 4 sự kiện)
- [x] 5. TDD: `ListingLock`, `ListingClient`, `PaymentClient`
- [x] 6. TDD: `DepositSagaService.start`, `POST /deposits`
- [x] 7. TDD: `PaymentEventsHandler` (`payment.deposited`)
- [x] 8. Test hạ tầng, đếm truy vấn; compose, docs, `code-review`, commit

## Tái sử dụng

Quét `services/_template-nest/src`, `services/listing/src`, `services/payment/src`, `services/identity/src`:

| Nhu cầu | Quyết định | Chỗ có sẵn |
|---|---|---|
| Khung service, `InternalHttpService` (timeout, retry, `details.outcome` C14), `@Idempotent()` + Redis, outbox, `EventConsumer` + `EventHandlerRegistry` + `processed_events`, `AuthModule`/`@Roles`/`@CurrentUser`, `PageQueryDto`/`Paginated`, `createUuidParamPipe` | DÙNG LẠI (chép nguyên) | `services/_template-nest` |
| `RedisService.client` cho khóa theo tin | DÙNG LẠI | template `src/redis` |
| Mẫu cờ bật module + biến bắt buộc | DÙNG LẠI cách làm | `listing.env.ts`, `payment.env.ts` |
| Nhận biết `23505` theo tên ràng buộc | Hàm cục bộ 1 dòng (không import service khác) | như payment `payment.errors.ts` |
| Test: `expectEventMatchesContract`, `expectResponseMatchesOpenApi`, `http-upstream.ts` (máy chủ HTTP giả cho listing, payment) | DÙNG LẠI | template `test/helpers` |
| `ListingLock`, `ListingClient`, `PaymentClient`, `DepositSagaService`, `ViewingService`, `PaymentEventsHandler` | VIẾT MỚI | Nghiệp vụ rental |

Không có thành phần dùng chung mới; không chạm `_template-nest`.

## Kế hoạch chi tiết

> **Claude tự duyệt 2026-11-21.** TDD bật (`warn`).

### A. Phạm vi T3.2 so với T3.3, T3.4 (theo `PHASE-3.md`)

| Có trong T3.2 | Để T3.3/T3.4 |
|---|---|
| `start` luồng thành công; lỗi giữ chỗ/snapshot trả nguyên (không có đơn); ghi đơn lỗi → nhả chỗ best-effort (`PUT AVAILABLE`), `500`; tạo order lỗi → `saga_log` theo `CallOutcome` rồi trả lỗi (đơn giữ `PENDING_PAYMENT`) | `CompensationService.cancelAfterHold` (test 5), job (a) đối soát (test 6–8), `ListingSyncService`, job (b), `HoldExpiryJob` (test 11–13, 16, 17) |
| `PaymentEventsHandler` đặt `listing_target_status='DEPOSITED'`, `listing_synced_at=null` | Đẩy `DEPOSITED` sang listing (job (b), T3.3) |

Cho tới T3.3, đơn có order lỗi nằm `PENDING_PAYMENT` tới khi job có mặt; chỗ ở listing tự hết theo `held_until`.

### B. Cách hiểu đã chọn (không thêm luật, mã lỗi)

| Chỗ | Cách làm |
|---|---|
| Lớp chặn 3 (`ux_deposits_active_listing`, `Processing_Flow §2`): "Lỗi DB → bù trừ, `409`" không ghi mã | `409 LISTING_NOT_AVAILABLE` (mã có sẵn, cùng nghĩa "người khác đã giữ") + nhả chỗ best-effort |
| Body `CreateOrderRequest` của payment cần `listingTitle` | Lấy `title` của bản chụp (`listing_title` của đơn) |
| `holdRemainingSeconds` | `max(0, floor((expiresAt - now)/1000))` |
| Snapshot `404` | Chuyển nguyên `404 LISTING_NOT_FOUND`; `approvalStatus ≠ APPROVED` hoặc `status ≠ AVAILABLE` → `409 LISTING_NOT_AVAILABLE` (§1 bước 3) |
| `RENTAL_INVALID_TRANSITION`, `RENTAL_VIEWING_*` | Đúng catalog `RE.VIEWING §3` |

### C. File

| File | Việc |
|---|---|
| `services/rental/**` | Chép template, `SERVICE_NAME=rental`, `PORT=3003`, bỏ module mẫu |
| `src/config/env.validation.ts` (+spec), `src/rental/config/rental.env.ts` (+spec), `env.bootstrap.ts`, `feature-flags.ts` | `HOLD_TTL_SECONDS` 600, `DEPOSIT_LOCK_TTL_MS` 10000, `LISTING_CALL_TIMEOUT_MS` 2000, `PAYMENT_CALL_TIMEOUT_MS` 3000, `REFUND_WINDOW_SECONDS` 172800, `AUTO_RELEASE_SECONDS` 259200; bắt buộc `DATABASE_URL`, `REDIS_URL`, `RABBITMQ_URL`, `INTERNAL_LISTING_URL`, `INTERNAL_PAYMENT_URL`, `JWT_ISSUER`, khóa công khai JWT |
| `src/database/migrations/1735000000000-create-rental-tables.ts` | DDL `RE.DEPOSIT_SAGA §6` + `RE.VIEWING §4` |
| `src/rental/entities/` `deposit`, `saga-log`, `viewing` | |
| `src/rental/locks/listing.lock.ts` (+spec) | `SET NX PX`, nhả bằng Lua so token |
| `src/rental/clients/listing.client.ts`, `payment.client.ts` (+spec) | Qua `InternalHttpService`; hold `POST` không retry; `createOrder` `idempotent: true`; `classify(err)` → `CallOutcome` |
| `src/rental/services/deposit-saga.service.ts` (+spec), `viewing.service.ts` (+spec) | |
| `src/rental/events/payment-events.handler.ts` (+spec) | Đăng ký `payment.deposited` |
| `src/rental/controllers/deposits.controller.ts`, `viewings.controller.ts`; `dto/`, `errors/rental.errors.ts`, `rental.module.ts` | |
| `test/setup-infra-env.ts`, `test/*.infra-spec.ts` | `rental_db`, Redis, RabbitMQ; listing, payment giả bằng `http-upstream` theo `example` của hợp đồng |
| `infra/compose/docker-compose.yml`, `.env.example` gốc (bỏ 4 biến luồng cũ theo A3), `services/rental/.env.example`, CI matrix | |
| README, `guides/RE_Rental_Code_Walkthrough.md`, `CLAUDE.md §2.5`, `project-structure.md`, `implementation/progress.md` (tick T2.5, T3.1) | |

### D. Số truy vấn

| Endpoint | Truy vấn |
|---|---|
| `POST /deposits` | 5: INSERT đơn, INSERT `saga_log`, INSERT outbox; UPDATE order, INSERT `saga_log` (`Processing_Flow §6`) — idempotency ở Redis |
| `POST /viewings` | 2: INSERT, outbox |
| respond / confirm-viewed / cancel | 2 (UPDATE, outbox) + 1 SELECT khi UPDATE 0 dòng |
| `GET /viewings/mine` | 2 (data + count), ngưỡng danh sách 4 |
| `payment.deposited` | inbox 1 + UPDATE 1 + SELECT 1 + UPDATE viewings 1 + outbox n |

## Blockers / Ghi chú

- `code-review` 5 chiều (2026-11-21): không CRITICAL, không MAJOR. Security: route có `@Roles`, người gọi luôn là `sub`; `saga_log.detail` chỉ có mã lỗi và status; không log URL có mật khẩu. Performance: 5/2/2/≤2 truy vấn, index theo DDL. Correctness: không transaction bao HTTP; khóa nhả theo token; `UPDATE ... WHERE status` cho mọi chuyển trạng thái; handler chỉ dùng `manager` của inbox. Style: đúng `Component_Class_Design §1`, controller mỏng. Reuse: không import chéo service. MINOR: ghi chú của chủ trọ khi từ chối chưa lưu (ghi walkthrough).

- Kiểm chứng end-to-end bằng payOS thử nghiệm thật cần khóa payOS của A và webhook (T3.4).
