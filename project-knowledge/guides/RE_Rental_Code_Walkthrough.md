# Giải thích code — rental

> Đọc khi: cần hiểu code của rental để sửa tiếp (vòng đời đơn T3.5), review, hoặc chuẩn bị vấn đáp.

| | |
|---|---|
| **Chủ sở hữu / Cập nhật** | hoang.lv — 2026-11-25 (T3.4b: hết hạn giữ chỗ `HoldExpiryJob`, khung job `IntervalJob`) |
| **Thành phần** | `services/rental/` (cổng 3003); phần chép từ `services/_template-nest/` ghi rõ ở §3.3 |
| **Task** | `T3.2` (khung, lịch xem, saga luồng thành công), `T3.3` (bù trừ, đối soát, đồng bộ listing; C20), `T3.4b` (hết hạn giữ chỗ, BR-09); `implementation/PHASE-3.md` |
| **Thiết kế** | `design/RENTAL/RE.DEPOSIT_SAGA/` (v1.4), `design/RENTAL/RE.VIEWING/` (v1.1), `RE.DEPOSIT_LIFECYCLE/API_Spec.md §6`, ADR-0004 |
| **Commit / PR** | T3.2: PR #27. T3.3: PR #29 (`207abc1`). T3.4b: nhánh `feature/T3.4b-hold-expiry` (A cùng Claude, 2026-11-25) |

## 1. Luồng chung

Người thuê gọi `POST /api/v1/deposits` (qua gateway, có `Idempotency-Key`). Rental lấy khóa Redis theo tin, đọc bản chụp tin ở listing, sinh `depositId` rồi nhờ listing **giữ chỗ** tới `now + HOLD_TTL_SECONDS`. Giữ được thì trong một transaction ghi đơn `PENDING_PAYMENT` (bản chụp số tiền, chủ tin, tiêu đề), `saga_log HOLD_LISTING OK` và sự kiện `rental.deposit-created` vào outbox; sau đó gọi payment tạo order + link payOS, lưu order và `saga_log CREATE_PAYMENT_ORDER OK`, nhả khóa, trả `201` kèm link. Khi payment phát `payment.deposited` (T3.4), `EventConsumer` của template giao vào `PaymentEventsHandler`: đơn thành `PAID`, đặt mốc 48h/72h, đánh dấu listing cần `DEPOSITED`, và hủy yêu cầu xem đang mở của người khác trên tin — tất cả trong transaction của inbox. Lịch xem là CRUD nhỏ: mỗi chuyển trạng thái là một `UPDATE ... WHERE status='REQUESTED' AND <người liên quan>` + outbox.

**Nhánh lỗi và đồng bộ (T3.3).** Tạo order lỗi được phân loại bằng `classifyCall`. Payment **chắc chắn chưa** có order (4xx, hoặc không gửi được request) → `CompensationService.cancelAfterHold`: một transaction chuyển đơn sang `CANCELLED` (kèm `cancelled_reason`), đặt đích listing `AVAILABLE`, ghi `saga_log` và outbox `rental.deposit-cancelled`; sau commit `ListingSyncService.push` trả tin về `AVAILABLE`; client nhận nguyên lỗi gốc. **Không rõ** (timeout, 5xx) → đơn giữ `PENDING_PAYMENT`, `saga_log UNKNOWN`. `SagaReconcileJob` chạy mỗi 15 giây: (a) đơn kẹt > 30 giây chưa có order → hỏi payment: có thì gắn, `404` thì bù trừ; (b) mọi đơn có đích listing chưa đồng bộ (sau bù trừ, sau `PAID` → `DEPOSITED`) → đẩy lại. Listing trả 4xx (C20) là kết cục cuối; `503`/`504`/kết nối thì lượt sau đẩy lại.

**Hết hạn giữ chỗ (T3.4b, BR-09).** `HoldExpiryJob` chạy mỗi 5 giây, lấy tối đa 50 đơn `PENDING_PAYMENT` quá `expires_at` (hết hạn sớm nhất trước). Với từng đơn: **hủy link trước** (`POST /internal/payment-orders/:depositId/cancel`); payment trả `200` hoặc `404` (chưa có order) → một transaction `EXPIRED` + đích `AVAILABLE` + `saga_log CANCEL_PAYMENT_ORDER OK {status}` + outbox `rental.deposit-expired`, rồi **nhả chỗ sau** (`ListingSyncService.push`). Payment trả `409 PAYMENT_ORDER_ALREADY_PAID` (người thuê trả sát giờ) → bỏ qua, chờ `payment.deposited` đưa đơn sang `PAID`. Mọi lỗi khác → giữ nguyên, lượt sau thử lại. Hai job dùng chung khung `IntervalJob` (lịch, bỏ lượt chồng, nuốt lỗi lượt).

```mermaid
sequenceDiagram
    participant J as HoldExpiryJob
    participant P as payment
    participant DB as rental_db
    participant L as listing
    loop mỗi 5 giây
      J->>DB: PENDING_PAYMENT và expires_at < now() (≤ 50)
      J->>P: POST /internal/payment-orders/:depositId/cancel
      alt 200 / 404
        J->>DB: BEGIN; UPDATE EXPIRED WHERE PENDING_PAYMENT; saga_log; outbox deposit-expired; COMMIT
        J->>L: PUT status AVAILABLE (lỗi tạm → SagaReconcileJob (b))
      else 409 ALREADY_PAID
        Note over J: bỏ qua, chờ payment.deposited
      else 503 / 504 / kết nối / 4xx khác
        Note over J: giữ PENDING_PAYMENT, lượt sau
      end
    end
```

```mermaid
sequenceDiagram
    participant R as rental
    participant P as payment
    participant DB as rental_db
    participant L as listing
    participant J as SagaReconcileJob
    R->>P: POST /internal/payment-orders
    P--xR: 4xx / không kết nối được
    R->>DB: BEGIN; UPDATE CANCELLED WHERE PENDING_PAYMENT; saga_log; outbox deposit-cancelled; COMMIT
    R->>L: PUT status AVAILABLE
    L-->>R: 200 → listing_synced_at (503 → để job)
    loop mỗi 15 giây
      J->>DB: đơn kẹt chưa có order; đích listing chưa đồng bộ
      J->>P: GET /internal/payment-orders/:depositId (có → gắn; 404 → bù trừ)
      J->>L: PUT status (AVAILABLE / DEPOSITED); 4xx → kết cục cuối (C20)
    end
```

```mermaid
sequenceDiagram
    participant T as Người thuê
    participant R as rental
    participant Rd as Redis
    participant L as listing
    participant P as payment
    participant DB as rental_db
    T->>R: POST /deposits + Idempotency-Key
    R->>Rd: SET lock:listing:{id} NX PX
    R->>L: GET /internal/listings/:id (bản chụp)
    R->>L: POST /internal/listings/:id/holds (không retry)
    R->>DB: BEGIN; INSERT deposits, saga_log, outbox; COMMIT
    R->>P: POST /internal/payment-orders (retry, idempotent theo depositId)
    R->>DB: BEGIN; UPDATE order; INSERT saga_log; COMMIT
    R->>Rd: DEL lock (Lua, đúng token)
    R-->>T: 201 checkoutUrl, qrCode, holdRemainingSeconds
    P--)R: payment.deposited (RabbitMQ)
    R->>DB: inbox + PAID + mốc + listing_target_status + hủy lịch xem người khác + outbox
```

## 2. Cây thư mục

```text
services/rental/
├─ src/
│  ├─ app.module.ts                 # nạp RentalModule khi có DB + Redis + RabbitMQ
│  ├─ config/                       # env.validation (+biến saga), env.bootstrap (+checkRentalEnv), feature-flags (+isRentalEnabled)
│  ├─ database/migrations/          # 1730000000001 messaging (template), 1735000000000 deposits, saga_log, viewings
│  └─ rental/
│     ├─ rental.module.ts
│     ├─ config/rental.env.ts       # biến bắt buộc riêng (+ spec)
│     ├─ locks/listing.lock.ts      # SET NX PX, nhả bằng Lua so token (+ spec)
│     ├─ clients/                   # listing.client, payment.client, call-outcome, client-config (+ clients.spec)
│     ├─ services/                  # deposit-saga, viewing, compensation, listing-sync (+ spec), saga-log.ts
│     ├─ jobs/                      # interval-job (T3.4b, khung chung), saga-reconcile (T3.3), hold-expiry (T3.4b) (+ spec)
│     ├─ events/payment-events.handler.ts (+ spec)
│     ├─ controllers/               # deposits.controller, viewings.controller
│     ├─ dto/                       # deposit.dto, viewing.dto
│     ├─ entities/                  # deposit, saga-log, viewing
│     └─ errors/rental.errors.ts
├─ test/
│  ├─ rental.infra-spec.ts          # DoD: saga test 1, 2, 9, 14–16, 18; lịch xem test 1–10
│  ├─ saga-compensation.infra-spec.ts # T3.3: test 5, 7, 8, 17, C20, PAID → DEPOSITED, 7 truy vấn; T3.4b: test 11–13, 16, 5 truy vấn
│  ├─ setup-infra-env.ts            # rental_db
│  └─ (e2e, messaging, storage của template)
├─ .env.example, Dockerfile, package.json, README.md
```

## 3. Chức năng từng file

### 3.1 Phần riêng của rental (`src/rental/`)

| File | Làm gì | Gọi tới / được gọi bởi | Ghi chú |
|---|---|---|---|
| `rental.module.ts` | Entity, 2 controller, provider; factory cho cấu hình client, `ListingLock` (từ `RedisService.client`), cấu hình saga, mốc, hai job (`SAGA_RECONCILE_CONFIG`, `HOLD_EXPIRY_CONFIG`) | `app.module.ts` | `InternalHttpService`, `RedisService`, `OutboxService`, `EventHandlerRegistry` đến từ module global của template |
| `config/rental.env.ts` | Biến bắt buộc: DB, Redis, RabbitMQ, 2 URL nội bộ, `JWT_ISSUER`, khóa công khai | `env.bootstrap.ts` (bỏ qua khi `NODE_ENV=test`) | Không in giá trị (URL có mật khẩu) |
| `locks/listing.lock.ts` | `acquire` = `SET lock:listing:{id} <token> PX DEPOSIT_LOCK_TTL_MS NX` → `409 RENTAL_DEPOSIT_IN_PROGRESS`; `release` = Lua `GET == token → DEL` | `DepositSagaService` | `release` không bao giờ ném (khóa tự hết theo TTL) |
| `clients/listing.client.ts` | `getSnapshot` (GET), `hold` (POST, **không** retry), `changeStatus` (PUT) | Saga, `ViewingService` | Timeout `LISTING_CALL_TIMEOUT_MS`; lỗi 4xx của listing chuyển nguyên |
| `clients/payment.client.ts` | `createOrder`, `cancelOrder` (POST `idempotent: true`), `getOrder` | Saga (T3.3, T3.4 dùng thêm) | Timeout `PAYMENT_CALL_TIMEOUT_MS` |
| `clients/call-outcome.ts` | `classifyCall(err)`: 4xx → `BUSINESS_ERROR`; 503/504 `details.outcome=NOT_EXECUTED` → `NOT_EXECUTED`; còn lại `UNKNOWN` | Saga | `Component_Class_Design §3`, C14 |
| `services/deposit-saga.service.ts` | `start(tenantId, listingId)`: các bước §1 `API_Spec` | `DepositsController` | Ghi đơn lỗi → nhả chỗ best-effort; trùng `ux_deposits_active_listing` → `409 LISTING_NOT_AVAILABLE`; tạo order lỗi `BUSINESS_ERROR`/`NOT_EXECUTED` → bù trừ (trong khóa) rồi ném lỗi gốc; `UNKNOWN` → `saga_log`, ném |
| `services/compensation.service.ts` | `cancelAfterHold(d, cause)`: transaction `UPDATE ... WHERE status='PENDING_PAYMENT'` → `CANCELLED` + `cancelled_reason` + đích `AVAILABLE`; `saga_log` nguyên nhân; outbox `rental.deposit-cancelled`; sau commit `push` | Saga, job (a) | 0 dòng → `false`, không làm gì (bên khác đã xử lý); lỗi đẩy không ném |
| `services/listing-sync.service.ts` | `push(d)`: `PUT /internal/listings/:id/status`; OK → `listing_synced_at` (chỉ khi đích chưa đổi); 4xx → kết cục cuối + `saga_log SYNC_LISTING BUSINESS_ERROR` kèm `details` (C20); lỗi tạm → `RETRY` | Bù trừ, job (b) | Lỗi tạm không ghi `saga_log` (tránh phình bảng); trả `SYNCED`/`REJECTED`/`RETRY`/`SKIPPED` |
| `services/saga-log.ts` | `sagaLogRow`, `errorDetail` (mã + status, `details` khi cần) | Mọi service ghi `saga_log` | Tách từ `DepositSagaService` khi thêm bù trừ |
| `jobs/interval-job.ts` (T3.4b) | Lớp cơ sở trừu tượng: `onApplicationBootstrap` đăng ký `setInterval` vào `SchedulerRegistry` theo `intervalMs` (`0` → không đăng ký); `tick()` bỏ lượt khi lượt trước chưa xong, lỗi `runOnce()` chỉ log `warn`; `onApplicationShutdown` xóa interval nếu còn | Được kế thừa bởi `SagaReconcileJob`, `HoldExpiryJob` | Lớp con chỉ viết `runOnce()`. Nằm trong `src/rental/` (không phải phần kỹ thuật chung): chỉ rental dùng `@nestjs/schedule` |
| `jobs/saga-reconcile.job.ts` | `runOnce()`: (a) đơn `PENDING_PAYMENT`, `payment_order_id IS NULL`, quá `SAGA_STUCK_AFTER_SECONDS` → `getOrder`; (b) `listing_target_status` chưa đồng bộ → `push` | Kế thừa `IntervalJob` (T3.4b), tên lịch `saga-reconcile` | Tối đa 50 đơn mỗi phần, cũ nhất trước; một đơn lỗi không chặn đơn khác; `SAGA_RECONCILE_INTERVAL_MS=0` tắt lịch |
| `jobs/hold-expiry.job.ts` (T3.4b) | `runOnce()`: đơn `PENDING_PAYMENT` quá `expires_at` (≤ 50, `ORDER BY expires_at`) → `PaymentClient.cancelOrder` → `200`/`404`: transaction `UPDATE ... WHERE status='PENDING_PAYMENT'` → `EXPIRED` + đích `AVAILABLE` + `saga_log` + outbox `rental.deposit-expired`, rồi `push`. Trả `{expired, paid, retry, skipped, failed}` | Kế thừa `IntervalJob`, tên lịch `hold-expiry`; `PaymentClient`, `OutboxService`, `ListingSyncService` | `409 ALREADY_PAID` → log `info`; lỗi khác → giữ, log `warn`; `UPDATE` 0 dòng → dừng; `HOLD_EXPIRY_INTERVAL_MS=0` tắt lịch |
| `services/viewing.service.ts` | `request`, `decline`, `confirmViewed`, `cancelByTenant`, `cancelOthersOnDeposit`, `findMine` | `ViewingsController`, `PaymentEventsHandler` | Mỗi chuyển: một transaction `UPDATE ... RETURNING` + outbox; 0 dòng → đọc lại để chọn 404/403/409 |
| `events/payment-events.handler.ts` | Đăng ký `payment.deposited`: `UPDATE ... WHERE status='PENDING_PAYMENT'` → `PAID` + mốc + `listing_target_status='DEPOSITED'`; rồi hủy lịch xem người khác | `EventConsumer` (template) | Không gọi HTTP; 0 dòng → log `warn` |
| `controllers/deposits.controller.ts` | `POST /deposits` `@Roles('TENANT')` `@Idempotent()` | Saga | |
| `controllers/viewings.controller.ts` | 5 route lịch xem | `ViewingService` | `:id` qua `createUuidParamPipe` |
| `dto/deposit.dto.ts`, `dto/viewing.dto.ts` | Body chỉ có `listingId` (trường lạ như `amountVnd` → 400); view lịch xem | Controller | `note` cắt khoảng trắng, ≤ 500 |
| `entities/*.ts` | `deposits` (đủ cột DDL, kể cả vòng đời đơn), `saga_log`, `viewings` | TypeORM | Tiền `bigint` → number qua `bigintToNumber` |
| `errors/rental.errors.ts` | Mã `RENTAL_*`; `LISTING_NOT_AVAILABLE`/`LISTING_NOT_FOUND` khi rental tự kết luận từ bản chụp; `isUniqueViolation` | Service | |

### 3.2 Cấu hình, database, triển khai

| File | Làm gì | Ghi chú |
|---|---|---|
| `src/database/migrations/1735000000000-create-rental-tables.ts` | DDL `RE.DEPOSIT_SAGA §6` + `RE.VIEWING §4`, đủ index (`ux_deposits_active_listing`, `ux_viewings_open_per_tenant`, ...) | Có `down` |
| `src/config/env.validation.ts` | Thêm `INTERNAL_LISTING_URL`, `INTERNAL_PAYMENT_URL` (http/https), `HOLD_TTL_SECONDS`, `DEPOSIT_LOCK_TTL_MS`, `LISTING_CALL_TIMEOUT_MS`, `PAYMENT_CALL_TIMEOUT_MS`, `REFUND_WINDOW_SECONDS`, `AUTO_RELEASE_SECONDS` | Mặc định theo thiết kế |
| `src/config/env.validation.ts` (T3.3) | `SAGA_RECONCILE_INTERVAL_MS` (0–3.600.000, mặc định 15.000; `0` tắt), `SAGA_STUCK_AFTER_SECONDS` (1–86.400, mặc định 30) | `test/setup-infra-env.ts` đặt `0` để job không tự chạy trong test |
| `src/config/env.validation.ts` (T3.4b) | `HOLD_EXPIRY_INTERVAL_MS` (0–3.600.000, mặc định 5.000; `0` tắt) | E4 cần ≤ 10 giây; `test/setup-infra-env.ts` đặt `0`; có ở `.env.example` gốc, rental và compose |
| `package.json` (T3.3) | `@nestjs/schedule@6.1.3` | Dòng 12.x là ESM thuần (`"type": "module"`), dự án CommonJS và Jest không nạp được; 6.x hỗ trợ Nest 10/11 |
| `src/config/feature-flags.ts` | `isRentalEnabled = DB && Redis && RabbitMQ` | Test chung của template thiếu một trong ba thì module không nạp |
| `.env.example` (rental, gốc), `infra/compose/docker-compose.yml`, `.github/workflows/ci.yml` | Biến rental; service `rental` profile `apps`; CI chạy test rental | `.env.example` gốc bỏ 4 biến luồng cũ (A3) |

### 3.3 Phần chép từ template (không giải thích lại)

`src/common/*`, `src/messaging/*`, `src/redis/*`, `src/storage/*`, `src/health/*`, `src/app.setup.ts`, `src/main.ts`, `src/swagger.setup.ts`, `src/database/{data-source,database.module,database.health,transformers}.ts`, migration messaging, `test/*.e2e-spec.ts`, `test/messaging.infra-spec.ts`, `test/storage.infra-spec.ts`, `test/helpers/*`: xem `services/_template-nest/README.md §3`. Đã xóa module mẫu.

### 3.4 Test

| File | Tầng | Kiểm |
|---|---|---|
| `services/deposit-saga.service.spec.ts` | unit | Thứ tự bước; bản chụp (BR-04); tin không `AVAILABLE`/chưa duyệt; giữ chỗ 409/503/504; lớp chặn 3; ghi đơn lỗi; tạo order lỗi theo `CallOutcome` |
| `services/viewing.service.spec.ts`, `events/payment-events.handler.spec.ts`, `clients/clients.spec.ts`, `locks/listing.lock.spec.ts`, `config/*.spec.ts` | unit | Từng thành phần với bản giả |
| `services/compensation.service.spec.ts`, `listing-sync.service.spec.ts`, `jobs/saga-reconcile.job.spec.ts` | unit | Thứ tự trong/ngoài transaction; chống đua 0 dòng; C20 và mọi 4xx; lỗi tạm không đánh dấu, không `saga_log`; job chọn đúng điều kiện, cô lập lỗi từng đơn, bỏ lượt chồng, bật/tắt lịch |
| `jobs/interval-job.spec.ts`, `jobs/hold-expiry.job.spec.ts` (T3.4b) | unit | Khung: đăng ký/tắt lịch, chạy theo chu kỳ, bỏ lượt chồng, nuốt lỗi lượt, dọn khi tắt. `HoldExpiryJob`: điều kiện chọn; test 11 (**thứ tự** hủy link → transaction → đẩy); `404` vẫn `EXPIRED`; test 12 (`409`, chỉ log `info`); test 13 với 5 loại lỗi (503 payOS, 504, `NOT_EXECUTED`, 400, lỗi lạ) và đơn sau vẫn chạy; `UPDATE` 0 dòng; lỗi DB; lỗi đẩy listing |
| `test/saga-compensation.infra-spec.ts` | infra | Postgres + Redis thật; listing, payment giả trên **hai cổng** (đóng cổng payment = "payment dừng"): test 5 (4xx và dừng hẳn, 7 truy vấn), 7, 8, đơn mới không bị đụng, 17, `PAID` → `DEPOSITED`, C20; `deposit-cancelled` khớp hợp đồng. T3.4b: payment giả thêm `/cancel` (200/404/409/503) và ghi **thứ tự** lời gọi; test 11 (E4: `cancel` trước `PUT status`, `deposit-expired` khớp hợp đồng, **5 truy vấn** = 1 `SELECT` + 4), `404`, test 12 (`409` rồi `payment.deposited` → `PAID`), test 13 (503 rồi payment dừng hẳn → giữ; hồi → `EXPIRED`), test 16 (đơn `EXPIRED` do job nhận `payment.deposited` → không đổi), đơn chưa hết hạn không bị đụng |
| `test/rental.infra-spec.ts` | infra | Postgres + Redis + RabbitMQ thật; listing, payment là máy chủ HTTP giả theo hợp đồng. Saga test 1, 2, 9, 18, giữ chỗ 409, 504, quyền, 5 truy vấn; `payment.deposited` phát lên RabbitMQ thật: test 14, 15, 16 + lịch xem test 7, 8; lịch xem test 1–6, 9, 10; sự kiện khớp `contracts/events` |

## 4. Quyết định không hiển nhiên

| Quyết định | Lý do | Phương án đã loại | Căn cứ |
|---|---|---|---|
| Giữ chỗ **trước** khi ghi đơn; ghi đơn **trước** khi gọi payment | Giữ chỗ không rõ kết quả thì chưa có đơn để dọn (`held_until` tự hết); rental chết sau khi payment tạo link thì đơn là manh mối cho job | Ghi đơn trước khi giữ chỗ | `Processing_Flow §1` |
| Không transaction nào bao HTTP | Không giữ kết nối, khóa DB khi chờ mạng | Một transaction dài | `developer.md` |
| Khóa Redis nhả bằng Lua so token | Saga quá TTL thì khóa đã của người khác | `DEL` thẳng | `Processing_Flow §2` lớp 1 |
| Lớp chặn 3 trả `409 LISTING_NOT_AVAILABLE` + nhả chỗ | Thiết kế ghi "lỗi DB → bù trừ, 409" không nêu mã; dùng mã có sẵn cùng nghĩa | Mã mới | Claude chọn 2026-11-21 (`decisions-log.md`) |
| Body chỉ `listingId`; `amountVnd` trong body → 400 | ValidationPipe `forbidNonWhitelisted`; số tiền luôn từ bản chụp (BR-04) | Bỏ qua im lặng | `API_Spec §1` |
| `payment.deposited` chỉ đánh dấu `listing_target_status`, không gọi listing | Handler chạy trong transaction inbox, không gọi HTTP; job (b) đẩy trong ≤ 15 giây | Gọi listing trong handler | `Component_Class_Design §6`, chốt 2026-11-16 |
| Chỉ bù trừ khi chắc payment **chưa** có order (`BUSINESS_ERROR`, `NOT_EXECUTED`) | Timeout/5xx có thể payment đã tạo order và người thuê đang trả: hủy đơn lúc đó làm mất tiền; để job (a) hỏi lại | Bù trừ mọi lỗi | `Processing_Flow §3`, C14 |
| Bù trừ chạy **trong** khóa Redis của saga | Không ai đặt cọc tin đó giữa lúc đơn đang hủy và tin chưa về `AVAILABLE` | Bù trừ sau khi nhả khóa | |
| `listing_target_status` + `listing_synced_at` thay vì gọi listing trực tiếp mọi nơi | Mọi chỗ cần đổi tin chỉ ghi "đích" trong DB cùng transaction; một chỗ đẩy (`push`) có thể chạy lại bất cứ lúc nào (`PUT` idempotent) | Gọi listing ở từng chỗ, lỗi thì mất | `Component_Class_Design §7` |
| Đánh dấu đã đồng bộ **chỉ khi** đích chưa đổi | Đơn vừa `PAID` (đích `DEPOSITED`) giữa lúc đang đẩy `AVAILABLE` thì không đánh dấu nhầm; lượt sau đẩy đích mới | `UPDATE ... WHERE id` | A duyệt B7 2026-11-22 |
| 4xx của listing là kết cục cuối (C20 mở rộng) | Đẩy lại 4xx không bao giờ thành công; `409 LISTING_INVALID_STATUS` nghĩa là tin đã thuộc đơn khác | Đẩy lại mãi | A chốt C20, B1 2026-11-22 |
| Lỗi tạm khi đẩy không ghi `saga_log` | Job 15 giây/lần, listing dừng 1 giờ sẽ ghi 240 dòng/đơn | Ghi mỗi lượt | A duyệt B2 |
| `@nestjs/schedule` 6.1.3, không phải 12.x | 12.x là ESM thuần; rental biên dịch CommonJS, Jest không nạp ESM | Tự viết `setTimeout` như `OutboxRelay` | `architecture.md §5` |
| Hết hạn: **hủy link trước, nhả chỗ sau** | Nhả chỗ trước thì người khác giữ được tin trong khi link cũ vẫn trả được → hai người cùng có chỗ | Nhả chỗ rồi hủy link | BR-09, `Processing_Flow §4` |
| Chỉ `200`/`404` của `cancel` mới `EXPIRED`; mọi lỗi khác (kể cả 4xx lạ) giữ đơn | Chưa chắc link đã hủy thì không nhả chỗ; giữ thêm vài giây an toàn hơn nhả sai | Coi 4xx lạ là kết cục cuối như C20 | A duyệt B4 2026-11-25 |
| `409 ALREADY_PAID` chỉ log `info`, không `saga_log` | Job 5 giây/lần sẽ gặp lại đơn tới khi `payment.deposited` tới; ghi mỗi lượt làm phình log | Ghi `saga_log` mỗi lượt | A duyệt B3 |
| `saga_log CANCEL_PAYMENT_ORDER OK {status}` trong transaction `EXPIRED` | Tra được vì sao đơn hết hạn và payment có order hay không (`200` vs `404`); cùng cách T3.3 ghi bước lỗi trong transaction bù trừ | Không ghi (bớt 1 truy vấn) | A duyệt B2 |
| Tách `IntervalJob`, `SagaReconcileJob` kế thừa | T3.4b là job thứ hai, T3.5 thêm hai job cùng khung; refactor không đổi hành vi (7 test cũ giữ nguyên) | Chép ~25 dòng mỗi job | A duyệt B5 |
| Infra test 12, 16 gọi thẳng handler `payment.deposited` (trong transaction) | Đường RabbitMQ thật đã kiểm ở `rental.infra-spec` (test 14–16); ở đây cần kết hợp với `HoldExpiryJob` và payment giả | Thêm kết nối RabbitMQ vào spec này | |
| `isRentalEnabled` đòi cả DB, Redis, RabbitMQ | Thiếu một trong ba thì saga, idempotency hoặc consumer không chạy được | Chỉ đòi DB | |

## 5. Câu hỏi vấn đáp

| Câu hỏi | Trả lời ngắn | Xem thêm |
|---|---|---|
| Hai người đặt cọc cùng tin cùng lúc? | Ba lớp: khóa Redis (`409 RENTAL_DEPOSIT_IN_PROGRESS`), `UPDATE ... WHERE status='AVAILABLE'` ở listing (`409 LISTING_NOT_AVAILABLE`), unique index đơn hoạt động ở rental | `Processing_Flow §2`, test 18 |
| Bấm "Đặt cọc" hai lần? | Cùng `Idempotency-Key` → interceptor trả lại response cũ (`Idempotent-Replayed: true`), một đơn | Test 9 |
| Người thuê sửa số tiền trong request? | Không được: body chỉ có `listingId`, trường lạ → 400; số tiền lấy từ bản chụp tin | Test 2 |
| `payment.deposited` đến hai lần? | Lần hai bị `processed_events` chặn (cùng `eventId`), hoặc `UPDATE ... WHERE status='PENDING_PAYMENT'` đổi 0 dòng | Test 15 |
| Vì sao không gọi listing ngay khi nhận `payment.deposited`? | Handler nằm trong transaction inbox; gọi HTTP trong đó giữ khóa DB và có thể lỗi làm rollback cả việc ghi nhận tiền. Job (b) đẩy `DEPOSITED` trong ≤ 15 giây | §4 |
| Payment sập đúng lúc đặt cọc? | Không gửi được request → chắc chắn chưa có order → bù trừ ngay: đơn `CANCELLED`, tin về `AVAILABLE`, người thuê nhận `503` và đặt lại được | Test 5, `PHASE-3.md` kiểm chứng |
| Payment chậm (timeout)? | Không biết order đã tạo chưa → giữ đơn; sau 30 giây job (a) hỏi payment: có order thì gắn (người thuê vẫn trả được), không có thì bù trừ (E8) | Test 6, 7, 8 |
| Listing sập lúc nhả chỗ? | Đơn vẫn `CANCELLED`, đích `AVAILABLE` nằm trong DB; job (b) đẩy lại mỗi 15 giây tới khi listing hồi | Test 17 |
| Listing trả 409 khi nhả chỗ? | Tin đã thuộc đơn khác: dừng, ghi `saga_log`, không đẩy lại (C20) | C20 |
| Hết 10 phút mà chưa trả tiền? | `HoldExpiryJob` (mỗi 5 giây) hủy link ở payment trước, rồi đơn `EXPIRED`, tin về `AVAILABLE`, phát `rental.deposit-expired`. Demo `HOLD_TTL_SECONDS=60` → `EXPIRED` trong ≤ 70 giây | Test 11, E4 |
| Vì sao phải hủy link trước khi nhả chỗ? | Nhả trước thì người B giữ được tin trong khi người A vẫn trả được vào link cũ → hai người cùng có chỗ | BR-09 |
| Người thuê trả tiền đúng giây cuối, job đang hủy? | Payment thấy order đã `PAID` → `409`; job bỏ qua, không `EXPIRED`; `payment.deposited` tới thì đơn `PAID` | Test 12 |
| Payment hoặc payOS sập lúc hết hạn? | Không biết link đã hủy chưa → giữ đơn và tin, mỗi 5 giây thử lại; payment hồi thì `EXPIRED` | Test 13 |
| Tiền đến sau khi đơn đã `EXPIRED`? | Order đã `CANCELLED` nên payment ghi `late_payments` + yêu cầu hoàn (BR-10, T3.4a); `payment.deposited` không phát, mà có phát thì rental cũng không đổi đơn `EXPIRED` | Test 16, E5 |
| Đơn vừa `PAID` giữa lúc job hủy link và ghi `EXPIRED`? | `UPDATE ... WHERE status='PENDING_PAYMENT'` đổi 0 dòng → job dừng, không phát sự kiện, không nhả chỗ | B7 |

## 6. Hạn chế đã biết

| Hạn chế | Ảnh hưởng | Hướng xử lý |
|---|---|---|
| Đơn quá hạn thành `EXPIRED` trễ tới 1 chu kỳ (5 giây) + thời gian xử lý | Tin còn `HELD` thêm vài giây sau `expires_at`; E4 cho phép ≤ 70 giây với hạn 60 giây | Chấp nhận (chốt 2026-11-16) |
| Payment dừng hẳn trong Docker | Mỗi lời gọi `cancel` chờ ~9 giây (C24) → một lượt 50 đơn có thể kéo dài nhiều phút; lượt mới bị bỏ tới khi xong, tin quá hạn bị giữ lâu hơn | Chờ quyết C24 / A2 |
| `409 ALREADY_PAID` lặp mỗi 5 giây | Tới khi `payment.deposited` tới (thường vài giây), job gọi `cancel` lại mỗi lượt | Chấp nhận (B3); RabbitMQ dừng lâu thì cần xem log `info` |
| Trễ hiển thị `DEPOSITED` ≤ 1 chu kỳ job (15 giây) | Trong lúc đó tin vẫn `HELD` (không ai giữ chỗ được) | Chấp nhận (chốt 2026-11-16) |
| Job (a) chỉ chạy với đơn quá 30 giây | Người thuê thấy `504` có thể đợi tới ~45 giây mới biết đơn hủy | Chấp nhận |
| Ghi chú của chủ trọ khi từ chối chưa lưu | `viewings.note` là của người thuê | Cần cột mới nếu muốn lưu |
| Một bản sao rental | `SagaReconcileJob`, `HoldExpiryJob` không chống chạy song song giữa nhiều bản sao (không `SKIP LOCKED`); mọi thay đổi là `UPDATE ... WHERE` trạng thái nên chạy trùng vẫn an toàn | Chốt 2026-11-16 |
| Test hạ tầng viết sau code (T3.3, T3.4b) | TDD chưa trọn ở tầng infra (unit vẫn đỏ trước, xanh sau); bù: cố ý bỏ hủy lịch xem và điều kiện `PENDING_PAYMENT` trong handler → 2 test đỏ | tech-debt #21 |
