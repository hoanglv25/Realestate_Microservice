---
task: T3.3 Saga: bù trừ, đối soát, đồng bộ listing
created: 2026-11-22
status: in_progress
phase: implementation/PHASE-3.md#T3.3
branch: feature/T3.3-saga-compensation (từ `develop` tại `6d03f6c`, sau PR #28 T3.4a)
---

## Mô tả

Hoàn thiện nhánh lỗi của saga đặt cọc: `CompensationService.cancelAfterHold` (tạo order `BUSINESS_ERROR`/`NOT_EXECUTED` → đơn `CANCELLED`, đích listing `AVAILABLE`, outbox `rental.deposit-cancelled`), `ListingSyncService.push` (đẩy `listing_target_status` sang listing, C20), `SagaReconcileJob` (a) đối soát đơn kẹt chưa có order, (b) đẩy lại đích listing chưa đồng bộ — gồm `DEPOSITED` sau `payment.deposited` (hiện tin giữ `HELD` sau khi đơn `PAID`). Người làm: A cùng Claude. Hạn M2 — 2026-12-04, ước ~10 giờ.

## Thiết kế liên quan

`design/RENTAL/RE.DEPOSIT_SAGA/` v1.2 (`Processing_Flow §3`, `Component_Class_Design §3, §5, §7, §8`, `API_Spec §2, §5, §8`), `RE.LISTING/API_Spec.md §2.2` (`PUT /internal/listings/:id/status`), `contracts/openapi/listing-internal.v1.yaml`, `payment-internal.v1.yaml`, `contracts/events/rental.deposit-cancelled.v1`. **C20 đã chốt 2026-11-22** (kết cục cuối). `architecture.md §5`: công việc nền dùng `@nestjs/schedule`. Hợp đồng: **không đổi**.

## Definition of Done

- [x] Test 3–8, 17 ở `RE.DEPOSIT_SAGA/Component_Class_Design.md §8` pass (+ C20) — 3, 4, 6 có từ T3.2; 5, 7, 8, 17, C20 mới (2026-11-22)
- [x] rental `test` 177/177, `test:e2e` 97/97 (môi trường Claude); `test:infra` **40/40 trên máy A** (2026-11-23 00:17: rental 18, saga-compensation 8, messaging 8, storage 6)
- [x] `pnpm lint`, `format:check`, `build`, `contracts:check` sạch
- [x] Số truy vấn: thành công 5; nhánh bù trừ 7 (đếm trong infra-spec, A chấp nhận B4)
- [x] Kiểm chứng (`PHASE-3.md`): dừng `payment` → đặt cọc → `504` (C24) → bật lại → job (a) `CANCELLED`, tin `AVAILABLE` (E8); đơn `PAID` → tin `DEPOSITED` (2026-11-23)
- [x] `RE.DEPOSIT_SAGA` v1.3 (đóng §8 C20) + `CHANGELOG.md`; walkthrough rental; `CLAUDE.md §2.5`; `.env.example` (gốc, rental), compose

## Các bước thực hiện (tổng quan)

- [x] 1. Đọc context, đối chiếu thiết kế (2026-11-22)
- [x] 2. Quét tái sử dụng + kế hoạch (dưới) — A duyệt cả B1–B7 (2026-11-22; B4 chấp nhận 7 ở nhánh bù trừ; B5 đồng ý @nestjs/schedule@12.0.3)
- [x] 3. Thêm `@nestjs/schedule` **6.1.3** (A duyệt `pnpm add`; 12.0.3 là ESM thuần, không chạy được — xem dưới), env `SAGA_RECONCILE_INTERVAL_MS`, `SAGA_STUCK_AFTER_SECONDS`
- [x] 4. TDD: `ListingSyncService.push` (OK, C20, lỗi tạm)
- [x] 5. TDD: `CompensationService.cancelAfterHold`; nối vào `DepositSagaService.createOrder`
- [x] 6. TDD: `SagaReconcileJob` (a), (b)
- [x] 7. Test hạ tầng (5, 6, 7, 8, 17, C20), đếm truy vấn
- [ ] 8. Kiểm chứng compose; thiết kế v1.3, walkthrough, `code-review`, commit

## Tái sử dụng

Quét `services/rental/src`, `services/_template-nest/src`, `services/payment/src`:

| Nhu cầu | Quyết định | Chỗ có sẵn |
|---|---|---|
| Phân loại lỗi lời gọi (`classify(err)` của thiết kế) | DÙNG LẠI | `rental/clients/call-outcome.ts` `classifyCall` (T3.2) |
| Đổi trạng thái tin, tra/hủy order | DÙNG LẠI | `ListingClient.changeStatus`, `PaymentClient.getOrder` (T3.2) |
| Ghi `saga_log` | MỞ RỘNG (tách hàm cục bộ dùng chung trong rental) | `DepositSagaService.log` (private) → `rental/services/saga-log.ts` |
| Outbox trong transaction | DÙNG LẠI | `OutboxService.add` |
| Chạy định kỳ | DÙNG LẠI thư viện đã chọn | `@nestjs/schedule` (`architecture.md §5`), `SchedulerRegistry.addInterval` theo biến môi trường |
| Máy chủ listing/payment giả cho test | DÙNG LẠI | `test/helpers/http-upstream.ts`, cách dựng trong `rental.infra-spec.ts` |
| `CompensationService`, `ListingSyncService`, `SagaReconcileJob` | VIẾT MỚI | Nghiệp vụ rental (`Component_Class_Design §1`) |

Không chạm `_template-nest`; không thành phần dùng chung mới ngoài `src/rental/`.

## Kế hoạch chi tiết

> A duyệt 2026-11-22. TDD bật (`warn`).

### A. Phạm vi

| Có trong T3.3 | Để sau |
|---|---|
| Bù trừ khi tạo order `BUSINESS_ERROR`/`NOT_EXECUTED` (test 5); `UNKNOWN` giữ `PENDING_PAYMENT` + `saga_log` (test 6, đã có từ T3.2) | `HoldExpiryJob` (T3.4b, test 11–13) |
| Job (a): đơn `PENDING_PAYMENT`, chưa có `payment_order_id`, quá `SAGA_STUCK_AFTER_SECONDS` → `getOrder`: có → gắn order; `404` → `cancelAfterHold` (test 7, 8) | Vòng đời đơn (T3.5) |
| Job (b): `listing_target_status` chưa đồng bộ → `push` (AVAILABLE sau bù trừ, DEPOSITED sau `PAID`) (test 17, C20) | |

### B. Điểm cần A quyết (đề xuất)

| # | Chỗ | Đề xuất |
|---|---|---|
| 1 | C20 chỉ nói `409 LISTING_INVALID_STATUS`; các 4xx khác của listing khi đẩy trạng thái (`404 LISTING_NOT_FOUND`, `400`) | Mọi 4xx (`BUSINESS_ERROR`) đều là **kết cục cuối** như C20 — đúng câu "chỉ `503`/`504`/lỗi kết nối mới đẩy lại" của `API_Spec §8`; đẩy lại 4xx không bao giờ thành công |
| 2 | Lỗi tạm khi đẩy (`503`/`504`/kết nối) | Chỉ log `warn`, **không** ghi `saga_log` mỗi lượt (job 15 giây/lần sẽ làm phình `saga_log`); `saga_log SYNC_LISTING` chỉ ghi kết cục cuối `BUSINESS_ERROR`. Thành công chỉ đặt `listing_synced_at` |
| 3 | `cancelled_reason` (varchar, thiết kế chưa liệt kê giá trị) | `PAYMENT_ORDER_REJECTED` (payment 4xx), `PAYMENT_UNAVAILABLE` (không gửi được), `PAYMENT_ORDER_NOT_FOUND` (job (a) thấy `404`) |
| 4 | Số truy vấn `POST /deposits` **nhánh bù trừ** (ngưỡng ghi 6) | 7: đơn + `saga_log` + outbox (3) → bù trừ một transaction: `UPDATE` đơn + `saga_log CREATE_PAYMENT_ORDER` (kết quả lỗi) + outbox `deposit-cancelled` (3) → đẩy `AVAILABLE` thành công: `UPDATE listing_synced_at` (1). Nhánh thành công giữ 5. Xin chấp nhận 7 ở nhánh lỗi |
| 5 | Thư viện `@nestjs/schedule` | `pnpm add @nestjs/schedule@12.0.3 --filter @realestate/rental` (đã có trong `architecture.md §5`; 12.0.3 phát hành 2026-11-06, đủ ≥ 2 tuần; 12.0.4 mới 9 ngày) |
| 6 | Chạy job | `SchedulerRegistry.addInterval` lúc khởi động theo `SAGA_RECONCILE_INTERVAL_MS` (mặc định 15000; `0` = tắt, dùng cho test); chặn chạy chồng (lượt trước chưa xong thì bỏ lượt); mỗi lượt tối đa 50 đơn mỗi phần; một đơn lỗi không chặn đơn khác; một bản sao rental (`Component_Class_Design §7`, đã chốt) |
| 7 | Đánh dấu đồng bộ | `UPDATE deposits SET listing_synced_at = now() WHERE id = $1 AND listing_target_status = $target AND listing_synced_at IS NULL` — nếu đích vừa đổi (ví dụ `PAID` giữa lúc đẩy `AVAILABLE`) thì không đánh dấu nhầm |

### C. File

| File | Việc |
|---|---|
| `services/rental/package.json`, `pnpm-lock.yaml` | `@nestjs/schedule@12.0.3` |
| `src/rental/config/rental.env.ts` (+spec), `src/config/env.validation.ts` (+spec) | `SAGA_RECONCILE_INTERVAL_MS` (≥ 0, mặc định 15000), `SAGA_STUCK_AFTER_SECONDS` (≥ 1, mặc định 30) |
| `src/rental/services/saga-log.ts` | Hàm dựng dòng `saga_log` (tách từ `DepositSagaService`) |
| `src/rental/services/listing-sync.service.ts` (+spec) | `push(deposit)`: gọi `changeStatus`; OK → đánh dấu; 4xx → đánh dấu + `saga_log SYNC_LISTING BUSINESS_ERROR` + `warn`; lỗi tạm → `warn`, để job |
| `src/rental/services/compensation.service.ts` (+spec) | `cancelAfterHold(deposit, err, reason)`: transaction §5 bước 1; 0 dòng → dừng; sau commit `push` best-effort |
| `src/rental/services/deposit-saga.service.ts` (+spec) | `createOrder`: `BUSINESS_ERROR`/`NOT_EXECUTED` → `cancelAfterHold` rồi ném lỗi gốc; `UNKNOWN` như cũ |
| `src/rental/jobs/saga-reconcile.job.ts` (+spec) | `runOnce()`: phần (a), (b); đăng ký interval |
| `src/rental/rental.module.ts`, `src/app.module.ts` | `ScheduleModule.forRoot()`, provider mới |
| `test/saga-compensation.infra-spec.ts` | Postgres + Redis thật, listing/payment giả: test 5, 6, 7, 8, 17, C20, đếm truy vấn, `deposit-cancelled` khớp hợp đồng |
| `.env.example` (gốc, rental), `infra/compose/docker-compose.yml` | Hai biến mới |
| `design/RENTAL/RE.DEPOSIT_SAGA/*` v1.3 + `CHANGELOG.md` | Đóng §8 C20, mục B1–B4, B7 |
| `guides/RE_Rental_Code_Walkthrough.md`, `CLAUDE.md §2.5` | Cập nhật |

### D. Test (`Component_Class_Design §8`)

| # | Tầng | Kiểm |
|---|---|---|
| 3, 4 | đã có (T3.2) | Giữ chỗ `409`/`503` → không có đơn |
| 5 | unit + infra | Tạo order `503` (`NOT_EXECUTED`) và `4xx` → `CANCELLED`, `cancelled_reason`, đích `AVAILABLE`, đã gọi `PUT status`, `deposit-cancelled`, client nhận lỗi gốc |
| 6 | đã có (T3.2) | Tạo order `504` → `PENDING_PAYMENT`, `saga_log UNKNOWN` |
| 7 | unit + infra | Job (a): order có → gắn `payment_order_id` (+ `checkout_url`) |
| 8 | unit + infra | Job (a): `404` → `CANCELLED`, tin `AVAILABLE` (E8) |
| 17 | unit + infra | Job (b): listing `503` → lượt sau đẩy lại tới khi xong; `PAID` → `DEPOSITED` |
| C20 | unit + infra | `409 LISTING_INVALID_STATUS` → đánh dấu đồng bộ, `saga_log BUSINESS_ERROR`, `warn`, lượt sau không đẩy lại |
| Chống đua | unit | Bù trừ khi đơn đã đổi (0 dòng) → dừng, không outbox, không đẩy |

### E. Số truy vấn

| Thao tác | Truy vấn |
|---|---|
| `POST /deposits` thành công | 5 (không đổi) |
| `POST /deposits` nhánh bù trừ | 7 (mục B4) |
| Job (b) mỗi đơn, thành công | 1 (`UPDATE synced`); C20: 2 (+ `saga_log`) |
| Job (a) mỗi đơn | gắn order 2 (`UPDATE` + `saga_log`); `404` → như bù trừ 3 + đẩy 1 |
| Mỗi lượt job | + 2 `SELECT` (a), (b), dùng `ix_deposits_listing_sync` và điều kiện `payment_order_id IS NULL` |

## Blockers / Ghi chú

- Cần A: duyệt mục B (đặc biệt B4 vượt ngưỡng ở nhánh lỗi, B5 thêm thư viện).
- Máy ảo Cowork không push được, không gọi được `localhost` Windows: A chạy git, compose, kiểm chứng.
- **Lệch so với kế hoạch:** (1) `@nestjs/schedule` **6.1.3** thay vì 12.0.3 đã duyệt: 12.x có `"type": "module"` (ESM thuần), rental biên dịch CommonJS và Jest báo "Must use import to load ES Module"; 6.1.3 (2026-04-15) hỗ trợ Nest 10/11, đủ ≥ 2 tuần. (2) `onApplicationShutdown` chỉ xóa interval nếu còn (`ScheduleModule` tự dọn trước). (3) `test/setup-infra-env.ts` đặt `SAGA_RECONCILE_INTERVAL_MS=0` để job không tự chạy giữa test (trước đó jest không thoát).
- **2026-11-22 code-review 5 chiều (T3.3): không CRITICAL, không MAJOR.** Security: không route mới; log/`saga_log` chỉ id, mã lỗi, status, `details` trạng thái tin (không dữ liệu cá nhân). Performance: thành công 5, bù trừ 7 (A chấp nhận), job 2 `SELECT`/lượt + 1–3/đơn, `take: 50`, điều kiện trùng `ix_deposits_listing_sync`. Correctness: bù trừ chỉ khi chắc payment chưa có order; mọi đổi trạng thái `UPDATE ... WHERE` trạng thái; không HTTP trong transaction; đánh dấu đồng bộ chỉ khi đích chưa đổi; một đơn lỗi không chặn đơn khác; không chạy chồng. Style: file theo `Component_Class_Design §1` (`jobs/`), controller không đổi, biến môi trường khai đủ. Reuse: `classifyCall`, client có sẵn; tách `saga-log.ts` để bỏ lặp; không import chéo service.
- **TDD:** unit env, `listing-sync`, `compensation`, `deposit-saga` (nhánh lỗi), `saga-reconcile.job` đều RED trước. `test/saga-compensation.infra-spec.ts` viết sau code → đột biến: C20 không phải kết cục cuối → 1 đỏ; bỏ bù trừ → 4 đỏ; đánh dấu không kiểm đích (unit) → 2 đỏ; trả lại → xanh (tech-debt #24).
- **Chạy thật** (`node dist/main.js`, `SAGA_RECONCILE_INTERVAL_MS=2000`): job chạy mỗi 2 giây, đơn `CANCELLED` chưa đồng bộ → `warn` "chưa đẩy được" (listing không chạy), `/health` db, redis, rabbitmq `up`, không lỗi.
- **Còn lại cho A:** `pnpm install --frozen-lockfile`; `pnpm --filter @realestate/rental test:infra` đủ bộ; dựng lại `rental` trong compose; kiểm chứng `PHASE-3.md` (dừng `payment` → đặt cọc → `503`, tin `AVAILABLE`) và đơn `PAID` → tin `DEPOSITED`; commit + PR.
- **Kiểm chứng compose (2026-11-23 00:10, A):** (1) đơn `PAID` lúc 23:29 → job (b) đẩy → tin `58fe028e…` `DEPOSITED` (hết lỗi tin còn `HELD`). (2) `docker stop re-payment` → đặt cọc → `504 UNKNOWN` sau 9,35 giây (không phải `503` như PHASE-3 dự đoán: DNS Docker trả `ENOTFOUND` sau 3.936 ms > timeout 3.000 ms, ghi C24) → đơn `PENDING_PAYMENT`; bật lại payment → job (a): `404` → đơn `CANCELLED`, `PAYMENT_ORDER_NOT_FOUND`, đã đẩy; tin `c3e2ea29…` `AVAILABLE` (E8). Nhánh `NOT_EXECUTED` → `503` ngay được kiểm ở infra-spec bằng cổng đóng (`ECONNREFUSED`).
