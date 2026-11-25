---
task: T3.4b Hết hạn giữ chỗ
created: 2026-11-25
status: in_progress
phase: implementation/PHASE-3.md#T3.4b
branch: feature/T3.4b-hold-expiry (từ `develop` tại `207abc1`, sau PR #29 T3.3)
---

## Mô tả

`HoldExpiryJob` (BR-09): đơn `PENDING_PAYMENT` quá `expires_at` → hủy order/link payOS ở payment **trước**, rồi `EXPIRED` + đích listing `AVAILABLE` + outbox `rental.deposit-expired`, rồi đẩy `AVAILABLE` sang listing. Người làm: A cùng Claude. Hạn M2 — 2026-12-04, ước ~4 giờ. Phụ thuộc T3.4a (đã tick).

## Thiết kế liên quan

`design/RENTAL/RE.DEPOSIT_SAGA/` v1.3: `Processing_Flow §4` (sơ đồ hết hạn), `Component_Class_Design §7` (bảng job), `§8` test 11–13, 16; `API_Spec §2` (`POST /internal/payment-orders/:depositId/cancel`), `§3` (`rental.deposit-expired`), `§5` (`HOLD_EXPIRY_INTERVAL_MS` 5000, `HOLD_TTL_SECONDS`). Hợp đồng: `contracts/openapi/payment-internal.v1.yaml` (`cancelPaymentOrder`: 200 / 404 `PAYMENT_ORDER_NOT_FOUND` / 409 `PAYMENT_ORDER_ALREADY_PAID` / 503), `contracts/events/rental.deposit-expired.v1.schema.json` — **không đổi**. Không `[cần xác nhận]` mở nào chạm T3.4b (C20 đã chốt; C24 không chặn).

## Definition of Done

- [x] Test 11–13, 16 ở `RE.DEPOSIT_SAGA/Component_Class_Design.md §8` pass — unit `hold-expiry.job.spec.ts` (13), infra `saga-compensation.infra-spec.ts` (6 mới; 16 với đơn `EXPIRED` do job) (2026-11-25)
- [x] rental `test` **196/196**, `test:e2e` **97/97** (môi trường Claude); `test:infra` **46/46 trên máy A** (2026-11-25 14:33: rental, saga-compensation, messaging, storage)
- [x] `pnpm lint`, `pnpm format:check`, `pnpm build`, `pnpm contracts:check` không lỗi (2026-11-25)
- [x] Số truy vấn `HoldExpiryJob` đếm bằng log SQL: một lượt 1 đơn = **5** (1 `SELECT` + 4), trong ngưỡng ghi 6 mỗi đơn
- [x] Kiểm chứng (`PHASE-3.md`, máy A, compose, 2026-11-25): `HOLD_TTL_SECONDS=60`, đơn `934afcdc…` tin 20 không thanh toán → `EXPIRED` sau **~65 giây** (hạn 07:44:20.94Z, `EXPIRED` 07:44:25.82Z: 4,9 giây sau hạn), `saga_log CANCEL_PAYMENT_ORDER OK {"status": 200}`, order `100002` `CANCELLED`, tin `AVAILABLE`, `held_by_deposit_id` trống, đã đồng bộ (E4); webhook giả `orderCode` 100002, 6.000.000đ → `late_payments` có dòng, `refund_request_id` có giá trị (E5)
- [x] `RE.DEPOSIT_SAGA` v1.4 + `CHANGELOG.md`; walkthrough rental; dòng `CLAUDE.md §2.5`; `.env.example` (gốc, rental), compose

## Các bước thực hiện (tổng quan)

- [x] 1. Đọc context, đối chiếu thiết kế (2026-11-25)
- [x] 2. Quét tái sử dụng + kế hoạch chi tiết — A duyệt cả B1–B7 (2026-11-25 14:15)
- [x] 3. Thiết kế v1.4 (chi tiết B1–B4, B6, B7, B5) trước code (2026-11-25)
- [x] 4. Env `HOLD_EXPIRY_INTERVAL_MS` (TDD: spec đỏ → xanh 12/12)
- [x] 5. TDD: `IntervalJob` (5 test, đỏ → xanh), `SagaReconcileJob` kế thừa (7 test cũ không sửa, xanh), `HoldExpiryJob` (13 test, đỏ → xanh), đăng ký module
- [x] 6. Test hạ tầng (11, `404`, 12, 13, 16, đơn chưa hết hạn), đếm truy vấn 5
- [x] 7. Walkthrough, `code-review` 5 chiều, commit; `test:infra` 46/46 và kiểm chứng E4/E5 trên máy A (2026-11-25) — còn push, PR

## Tái sử dụng

> Quét 2026-11-25 · Nguồn: `services/rental/src`, `services/rental/test`, `services/_template-nest/src`, `services/*/src` (phát hiện trùng), `contracts/openapi/payment-internal.v1.yaml`, `contracts/events/`, `services/rental/package.json` · Cách tra: grep `addInterval|setInterval|SchedulerRegistry|@Interval|@Cron`, `running`, `cancelOrder|cancel`, `deposit-expired`, `HOLD_EXPIRY|HOLD_TTL`, `EXPIRED`; đọc `saga-reconcile.job.ts`, `compensation.service.ts`, `payment.client.ts`, `call-outcome.ts`, `saga-log.ts`, `saga-compensation.infra-spec.ts`
> Vùng mù: không

| Thành phần cần | Nhóm | Vị trí đã có / lý do viết mới |
|---|---|---|
| Hủy order ở payment | DÙNG LẠI | `src/rental/clients/payment.client.ts#PaymentClient.cancelOrder` (T3.2, `idempotent: true`, timeout `PAYMENT_CALL_TIMEOUT_MS`) |
| Phân loại lỗi lời gọi | DÙNG LẠI | `src/rental/clients/call-outcome.ts#classifyCall` |
| Mã lỗi + `details` ghi log/`saga_log` | DÙNG LẠI | `src/rental/services/saga-log.ts#errorDetail`, `#sagaLogRow` |
| Đẩy `AVAILABLE` sang listing (C20, đánh dấu đồng bộ) | DÙNG LẠI | `src/rental/services/listing-sync.service.ts#ListingSyncService.push`; lỗi tạm → `SagaReconcileJob` (b) |
| Outbox trong transaction | DÙNG LẠI | `src/messaging/outbox.service.ts#OutboxService.add` |
| Chống đua theo trạng thái | DÙNG LẠI (cách làm) | `UPDATE ... WHERE status='PENDING_PAYMENT'` như `CompensationService.cancelAfterHold` |
| Khung chạy định kỳ (addInterval theo env, `0` tắt, bỏ lượt chồng, nuốt lỗi lượt, dọn khi tắt) | **MỞ RỘNG** (B5) | Hiện chỉ nằm trong `src/rental/jobs/saga-reconcile.job.ts#SagaReconcileJob` (`onApplicationBootstrap`, `tick`, `onApplicationShutdown`). Tách thành lớp cơ sở `src/rental/jobs/interval-job.ts#IntervalJob` trong rental (không phải phần kỹ thuật chung: `@nestjs/schedule` chỉ rental dùng → không chạm `_template-nest`). `OutboxRelay` của template có khung riêng (Promise), không dùng chung được |
| Máy chủ listing/payment giả, đếm truy vấn, kiểm hợp đồng sự kiện | MỞ RỘNG | `test/saga-compensation.infra-spec.ts`: thêm route `POST /internal/payment-orders/:id/cancel` (chế độ 200/404/409/503) vào payment giả, thêm `describe('HoldExpiryJob')`; `test/helpers/contracts.ts#expectEventMatchesContract` |
| Payload `rental.deposit-expired` | DÙNG LẠI (schema) | `contracts/events/rental.deposit-expired.v1.schema.json` — cùng 4 trường với `DepositCancelledPayload` (`compensation.service.ts`); khai interface `DepositExpiredPayload` trong `hold-expiry.job.ts` |
| `HoldExpiryJob` | VIẾT MỚI | Nghiệp vụ rental (`Component_Class_Design §1`: `jobs/hold-expiry.job.ts`); grep `HoldExpiry|EXPIRED` trong `src/rental`: chưa có xử lý |

## Kế hoạch chi tiết

> **A duyệt cả B1–B7 (2026-11-25 14:15).** TDD bật (`warn`): mỗi hành vi RED → GREEN → REFACTOR.

### A. Phạm vi

| Có trong T3.4b | Để sau / không làm |
|---|---|
| `HoldExpiryJob`: chọn đơn, hủy order, `EXPIRED`, outbox, đẩy `AVAILABLE` (test 11, 12, 13) | Hoàn tiền khi tiền đến sau `EXPIRED` — payment đã làm ở T3.4a (`late_payments`, BR-10); T3.4b chỉ kiểm chứng E5 |
| Test 16 hạ tầng thật (`payment.deposited` khi đơn `EXPIRED` → không đổi; unit có từ T3.2) | Vòng đời đơn `DeadlineJob`, `AutoReleaseJob` (T3.5) — dùng lại `IntervalJob` nếu B5 duyệt |
| Env `HOLD_EXPIRY_INTERVAL_MS` | C24 (timeout DNS Docker) — chờ A2 |

### B. Điểm cần A quyết (đề xuất)

| # | Chỗ | Đề xuất |
|---|---|---|
| 1 | `HOLD_EXPIRY_INTERVAL_MS` (thiết kế chỉ có mặc định 5000) | `0` = tắt lịch, như `SAGA_RECONCILE_INTERVAL_MS` (test gọi `runOnce()`); Joi `integer, min 0, max 3600000, default 5000`. Ghi `API_Spec §5` v1.4 |
| 2 | `saga_log` khi hết hạn (§7 không nói) | Ghi `saga_log CANCEL_PAYMENT_ORDER OK {status: 200 \| 404}` **trong** transaction `EXPIRED` (bước đã có trong enum và DDL) — để tra vì sao đơn `EXPIRED` và order có hay không; cùng cách T3.3 ghi bước lỗi trong transaction bù trừ. Không ghi thì bớt 1 truy vấn |
| 3 | `409 PAYMENT_ORDER_ALREADY_PAID` (webhook thắng) | Bỏ qua đơn, log `info` (không `warn`, không `saga_log`: job 5 giây/lần sẽ lặp tới khi `payment.deposited` tới, thường vài giây) |
| 4 | Lỗi khác của `cancel` | `503 PAYMENT_PROVIDER_UNAVAILABLE`, `504`, lỗi kết nối, **và mọi 4xx khác** (`400`…) → giữ `PENDING_PAYMENT`, log `warn`, lượt sau thử lại (test 13). Lý do: chưa chắc link đã hủy thì không nhả chỗ (BR-09 "hủy link trước"). Chỉ `200`/`404` mới `EXPIRED` |
| 5 | Khung chạy định kỳ lặp lại | Tách `IntervalJob` (lớp cơ sở trừu tượng, `src/rental/jobs/interval-job.ts`): `name`, `intervalMs`, `runOnce()`; lo `addInterval`, `0` tắt, bỏ lượt khi lượt trước chưa xong, lỗi lượt chỉ log `warn`, xóa interval khi tắt. `SagaReconcileJob` chuyển sang kế thừa — refactor **không đổi hành vi**, test cũ giữ nguyên và phải xanh. Lý do: T3.4b thêm job thứ 2, T3.5 thêm 2 job nữa. Phương án khác: chép ~25 dòng vào `HoldExpiryJob` |
| 6 | Số truy vấn | Mỗi lượt 1 `SELECT` (`status='PENDING_PAYMENT' AND expires_at < now()`, `ORDER BY expires_at ASC`, `LIMIT 50`, dùng `ix_deposits_expiry`). Mỗi đơn hết hạn: transaction `UPDATE` đơn + `saga_log` (B2) + outbox = 3, đẩy thành công đánh dấu 1 → **4**; listing trả 4xx (C20) đánh dấu + `saga_log` 2 → **5**; ≤ ngưỡng ghi 6. Lời gọi HTTP mỗi đơn: `cancel` 1 + `PUT status` 1 (job xử lý từng đơn, như `SagaReconcileJob` §7). Ghi `Processing_Flow §6` |
| 7 | `UPDATE` 0 dòng (đơn vừa thành `PAID`/`CANCELLED` giữa `cancel` và transaction) | Dừng, không outbox, không đẩy listing, log `info` (đúng cột "Chống đua" §7) |

### C. File

| File | Việc |
|---|---|
| `project-knowledge/design/RENTAL/RE.DEPOSIT_SAGA/API_Spec.md` | §5: `HOLD_EXPIRY_INTERVAL_MS` `0` tắt (B1) |
| `.../Component_Class_Design.md` | §7: chi tiết `HoldExpiryJob` (B2–B5, B7); §1 thêm `interval-job.ts` (nếu B5) |
| `.../Processing_Flow.md` | §6: số truy vấn `HoldExpiryJob` (B6) |
| `.../CHANGELOG.md` | v1.4 (MINOR), không đổi route, mã lỗi, hợp đồng |
| `services/rental/src/config/env.validation.ts` (+ `.spec.ts`) | `HOLD_EXPIRY_INTERVAL_MS` |
| `services/rental/.env.example`, `.env.example` gốc, `infra/compose/docker-compose.yml` | Thêm biến (cùng commit) |
| `services/rental/src/rental/jobs/interval-job.ts` (+ `.spec.ts`) | MỚI (B5) |
| `services/rental/src/rental/jobs/saga-reconcile.job.ts` | Kế thừa `IntervalJob` (B5), không đổi hành vi |
| `services/rental/src/rental/jobs/hold-expiry.job.ts` (+ `.spec.ts`) | MỚI |
| `services/rental/src/rental/rental.module.ts` | Đăng ký `HoldExpiryJob`, `HOLD_EXPIRY_CONFIG`; sửa chú thích module |
| `services/rental/test/setup-infra-env.ts` | `HOLD_EXPIRY_INTERVAL_MS: '0'` |
| `services/rental/test/saga-compensation.infra-spec.ts` | Payment giả thêm `/cancel`; `describe('HoldExpiryJob')` |
| `project-knowledge/guides/RE_Rental_Code_Walkthrough.md`, `project-knowledge/CLAUDE.md §2.5` | Cập nhật (không tạo file mới) |

### D. Test

| Tầng | Test |
|---|---|
| `test` (`interval-job.spec.ts`) | `0` → không đăng ký; >0 → `addInterval` đúng tên; lượt chồng bị bỏ; lỗi `runOnce` không ném ra; tắt → xóa interval |
| `test` (`hold-expiry.job.spec.ts`) | **11** `cancel` 200 → `cancelOrder` gọi **trước** transaction; `EXPIRED`, `listingTargetStatus='AVAILABLE'`, `listingSyncedAt=null`, `saga_log`, outbox `rental.deposit-expired`; rồi `push`. `404` → như 11. **12** `409 ALREADY_PAID` → không transaction, không `push`. **13** `503`/`504`/kết nối/`400` → giữ `PENDING_PAYMENT`, không `push`, đơn sau vẫn được xử lý. `UPDATE` 0 dòng → không outbox, không `push`. `push` ném lỗi → đơn vẫn `EXPIRED`, kết quả đếm `failed`/để job (b) |
| `test` (`saga-reconcile.job.spec.ts`) | Giữ nguyên, phải xanh sau refactor (B5) |
| `test:infra` (`saga-compensation.infra-spec.ts`) | **11 (E4)**: đơn quá hạn → `runOnce` → `EXPIRED`, `deposit-expired` khớp hợp đồng, thứ tự gọi `cancel` rồi `PUT status AVAILABLE`, tin `AVAILABLE`, đếm truy vấn. **12**: `409` → vẫn `PENDING_PAYMENT`; phát `payment.deposited` → `PAID`. **13**: payment `503` → giữ, lượt sau `200` → `EXPIRED`. **16**: đơn `EXPIRED` nhận `payment.deposited` → không đổi. Đơn chưa hết hạn → job không đụng |

### E. Kiểm chứng (máy A, compose)

1. `.env`: `HOLD_TTL_SECONDS=60` (`HOLD_EXPIRY_INTERVAL_MS` mặc định 5000), `pnpm infra:up` + apps.
2. Đặt cọc một tin qua gateway (tạo link payOS thật — không trả tiền), ghi `orderCode`.
3. Chờ: đơn `EXPIRED` trong ≤ 70 giây sau khi tạo; order payment `CANCELLED`; tin `AVAILABLE` (E4). Ghi thời điểm thật.
4. `pnpm --filter @realestate/payment webhook:fake -- --order-code <orderCode> --amount <tiền cọc>` → `late_payments` có dòng, yêu cầu hoàn tạo (E5, BR-10 — code T3.4a).

### F. Thứ tự

Thiết kế v1.4 → env → `IntervalJob` (TDD) → refactor `SagaReconcileJob` (test cũ xanh) → `HoldExpiryJob` (TDD theo D) → module → infra-spec → lint/format/build/contracts → kiểm chứng (A) → walkthrough → `code-review` → commit, PR.

## Blockers / Ghi chú

- **Môi trường chạy test (2026-11-25):** máy ảo trên máy A không đọc được `node_modules` (junction của pnpm trên Windows). Claude clone `develop` vào môi trường riêng, `pnpm install --frozen-lockfile`, chạy test ở đó, rồi chép 13 file code về máy A (mã băm khớp). Hạ tầng cho `test:infra`: Postgres 16, Redis, RabbitMQ cài trực tiếp, nạp `infra/rabbitmq/definitions.json` thật; S3 (image `silo`) không có → `storage.infra-spec` (6 test, template) chưa chạy.
- **code-review 5 chiều (2026-11-25):** không CRITICAL/MAJOR. MINOR: `DepositExpiredPayload` trùng hình với `DepositCancelledPayload` (giữ riêng theo hợp đồng sự kiện); log lỗi lượt của `SagaReconcileJob` đổi tiền tố từ tên lớp sang `saga-reconcile`.
