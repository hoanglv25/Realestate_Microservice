# Giải thích code — rental

> Đọc khi: cần hiểu code của rental để sửa tiếp (bù trừ, job T3.3, T3.4; vòng đời đơn T3.5), review, hoặc chuẩn bị vấn đáp.

| | |
|---|---|
| **Chủ sở hữu / Cập nhật** | hoang.lv — 2026-11-21 |
| **Thành phần** | `services/rental/` (cổng 3003); phần chép từ `services/_template-nest/` ghi rõ ở §3.3 |
| **Task** | `T3.2` (khung, lịch xem, saga luồng thành công; `implementation/PHASE-3.md`) |
| **Thiết kế** | `design/RENTAL/RE.DEPOSIT_SAGA/` (v1.2), `design/RENTAL/RE.VIEWING/` (v1.1), `RE.DEPOSIT_LIFECYCLE/API_Spec.md §6`, ADR-0004 |
| **Commit / PR** | Nhánh `feature/T3.2-rental-saga` (Claude làm khi A vắng, 2026-11-21) |

## 1. Luồng chung

Người thuê gọi `POST /api/v1/deposits` (qua gateway, có `Idempotency-Key`). Rental lấy khóa Redis theo tin, đọc bản chụp tin ở listing, sinh `depositId` rồi nhờ listing **giữ chỗ** tới `now + HOLD_TTL_SECONDS`. Giữ được thì trong một transaction ghi đơn `PENDING_PAYMENT` (bản chụp số tiền, chủ tin, tiêu đề), `saga_log HOLD_LISTING OK` và sự kiện `rental.deposit-created` vào outbox; sau đó gọi payment tạo order + link payOS, lưu order và `saga_log CREATE_PAYMENT_ORDER OK`, nhả khóa, trả `201` kèm link. Khi payment phát `payment.deposited` (T3.4), `EventConsumer` của template giao vào `PaymentEventsHandler`: đơn thành `PAID`, đặt mốc 48h/72h, đánh dấu listing cần `DEPOSITED`, và hủy yêu cầu xem đang mở của người khác trên tin — tất cả trong transaction của inbox. Lịch xem là CRUD nhỏ: mỗi chuyển trạng thái là một `UPDATE ... WHERE status='REQUESTED' AND <người liên quan>` + outbox.

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
│     ├─ services/                  # deposit-saga.service, viewing.service (+ spec)
│     ├─ events/payment-events.handler.ts (+ spec)
│     ├─ controllers/               # deposits.controller, viewings.controller
│     ├─ dto/                       # deposit.dto, viewing.dto
│     ├─ entities/                  # deposit, saga-log, viewing
│     └─ errors/rental.errors.ts
├─ test/
│  ├─ rental.infra-spec.ts          # DoD: saga test 1, 2, 9, 14–16, 18; lịch xem test 1–10
│  ├─ setup-infra-env.ts            # rental_db
│  └─ (e2e, messaging, storage của template)
├─ .env.example, Dockerfile, package.json, README.md
```

## 3. Chức năng từng file

### 3.1 Phần riêng của rental (`src/rental/`)

| File | Làm gì | Gọi tới / được gọi bởi | Ghi chú |
|---|---|---|---|
| `rental.module.ts` | Entity, 2 controller, provider; factory cho cấu hình client, `ListingLock` (từ `RedisService.client`), cấu hình saga và mốc | `app.module.ts` | `InternalHttpService`, `RedisService`, `OutboxService`, `EventHandlerRegistry` đến từ module global của template |
| `config/rental.env.ts` | Biến bắt buộc: DB, Redis, RabbitMQ, 2 URL nội bộ, `JWT_ISSUER`, khóa công khai | `env.bootstrap.ts` (bỏ qua khi `NODE_ENV=test`) | Không in giá trị (URL có mật khẩu) |
| `locks/listing.lock.ts` | `acquire` = `SET lock:listing:{id} <token> PX DEPOSIT_LOCK_TTL_MS NX` → `409 RENTAL_DEPOSIT_IN_PROGRESS`; `release` = Lua `GET == token → DEL` | `DepositSagaService` | `release` không bao giờ ném (khóa tự hết theo TTL) |
| `clients/listing.client.ts` | `getSnapshot` (GET), `hold` (POST, **không** retry), `changeStatus` (PUT) | Saga, `ViewingService` | Timeout `LISTING_CALL_TIMEOUT_MS`; lỗi 4xx của listing chuyển nguyên |
| `clients/payment.client.ts` | `createOrder`, `cancelOrder` (POST `idempotent: true`), `getOrder` | Saga (T3.3, T3.4 dùng thêm) | Timeout `PAYMENT_CALL_TIMEOUT_MS` |
| `clients/call-outcome.ts` | `classifyCall(err)`: 4xx → `BUSINESS_ERROR`; 503/504 `details.outcome=NOT_EXECUTED` → `NOT_EXECUTED`; còn lại `UNKNOWN` | Saga | `Component_Class_Design §3`, C14 |
| `services/deposit-saga.service.ts` | `start(tenantId, listingId)`: các bước §1 `API_Spec` | `DepositsController` | Ghi đơn lỗi → nhả chỗ best-effort; trùng `ux_deposits_active_listing` → `409 LISTING_NOT_AVAILABLE`; tạo order lỗi → `saga_log` theo `CallOutcome`, ném nguyên (bù trừ T3.3) |
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
| `src/config/feature-flags.ts` | `isRentalEnabled = DB && Redis && RabbitMQ` | Test chung của template thiếu một trong ba thì module không nạp |
| `.env.example` (rental, gốc), `infra/compose/docker-compose.yml`, `.github/workflows/ci.yml` | Biến rental; service `rental` profile `apps`; CI chạy test rental | `.env.example` gốc bỏ 4 biến luồng cũ (A3) |

### 3.3 Phần chép từ template (không giải thích lại)

`src/common/*`, `src/messaging/*`, `src/redis/*`, `src/storage/*`, `src/health/*`, `src/app.setup.ts`, `src/main.ts`, `src/swagger.setup.ts`, `src/database/{data-source,database.module,database.health,transformers}.ts`, migration messaging, `test/*.e2e-spec.ts`, `test/messaging.infra-spec.ts`, `test/storage.infra-spec.ts`, `test/helpers/*`: xem `services/_template-nest/README.md §3`. Đã xóa module mẫu.

### 3.4 Test

| File | Tầng | Kiểm |
|---|---|---|
| `services/deposit-saga.service.spec.ts` | unit | Thứ tự bước; bản chụp (BR-04); tin không `AVAILABLE`/chưa duyệt; giữ chỗ 409/503/504; lớp chặn 3; ghi đơn lỗi; tạo order lỗi theo `CallOutcome` |
| `services/viewing.service.spec.ts`, `events/payment-events.handler.spec.ts`, `clients/clients.spec.ts`, `locks/listing.lock.spec.ts`, `config/*.spec.ts` | unit | Từng thành phần với bản giả |
| `test/rental.infra-spec.ts` | infra | Postgres + Redis + RabbitMQ thật; listing, payment là máy chủ HTTP giả theo hợp đồng. Saga test 1, 2, 9, 18, giữ chỗ 409, 504, quyền, 5 truy vấn; `payment.deposited` phát lên RabbitMQ thật: test 14, 15, 16 + lịch xem test 7, 8; lịch xem test 1–6, 9, 10; sự kiện khớp `contracts/events` |

## 4. Quyết định không hiển nhiên

| Quyết định | Lý do | Phương án đã loại | Căn cứ |
|---|---|---|---|
| Giữ chỗ **trước** khi ghi đơn; ghi đơn **trước** khi gọi payment | Giữ chỗ không rõ kết quả thì chưa có đơn để dọn (`held_until` tự hết); rental chết sau khi payment tạo link thì đơn là manh mối cho job | Ghi đơn trước khi giữ chỗ | `Processing_Flow §1` |
| Không transaction nào bao HTTP | Không giữ kết nối, khóa DB khi chờ mạng | Một transaction dài | `developer.md` |
| Khóa Redis nhả bằng Lua so token | Saga quá TTL thì khóa đã của người khác | `DEL` thẳng | `Processing_Flow §2` lớp 1 |
| Lớp chặn 3 trả `409 LISTING_NOT_AVAILABLE` + nhả chỗ | Thiết kế ghi "lỗi DB → bù trừ, 409" không nêu mã; dùng mã có sẵn cùng nghĩa | Mã mới | Claude chọn 2026-11-21 (`decisions-log.md`) |
| Body chỉ `listingId`; `amountVnd` trong body → 400 | ValidationPipe `forbidNonWhitelisted`; số tiền luôn từ bản chụp (BR-04) | Bỏ qua im lặng | `API_Spec §1` |
| `payment.deposited` chỉ đánh dấu `listing_target_status`, không gọi listing | Handler chạy trong transaction inbox, không gọi HTTP; job (b) đẩy ở T3.3 | Gọi listing trong handler | `Component_Class_Design §6`, chốt 2026-11-16 |
| `isRentalEnabled` đòi cả DB, Redis, RabbitMQ | Thiếu một trong ba thì saga, idempotency hoặc consumer không chạy được | Chỉ đòi DB | |

## 5. Câu hỏi vấn đáp

| Câu hỏi | Trả lời ngắn | Xem thêm |
|---|---|---|
| Hai người đặt cọc cùng tin cùng lúc? | Ba lớp: khóa Redis (`409 RENTAL_DEPOSIT_IN_PROGRESS`), `UPDATE ... WHERE status='AVAILABLE'` ở listing (`409 LISTING_NOT_AVAILABLE`), unique index đơn hoạt động ở rental | `Processing_Flow §2`, test 18 |
| Bấm "Đặt cọc" hai lần? | Cùng `Idempotency-Key` → interceptor trả lại response cũ (`Idempotent-Replayed: true`), một đơn | Test 9 |
| Người thuê sửa số tiền trong request? | Không được: body chỉ có `listingId`, trường lạ → 400; số tiền lấy từ bản chụp tin | Test 2 |
| `payment.deposited` đến hai lần? | Lần hai bị `processed_events` chặn (cùng `eventId`), hoặc `UPDATE ... WHERE status='PENDING_PAYMENT'` đổi 0 dòng | Test 15 |
| Vì sao không gọi listing ngay khi nhận `payment.deposited`? | Handler nằm trong transaction inbox; gọi HTTP trong đó giữ khóa DB và có thể lỗi làm rollback cả việc ghi nhận tiền | §4 |

## 6. Hạn chế đã biết

| Hạn chế | Ảnh hưởng | Hướng xử lý |
|---|---|---|
| Chưa bù trừ khi tạo order lỗi | Đơn nằm `PENDING_PAYMENT`, tin `HELD` tới khi `held_until` hết | T3.3 (`CompensationService`, job (a)) |
| Chưa đẩy `DEPOSITED` sang listing | Tin vẫn `HELD` ở listing sau khi `PAID` | T3.3 (job (b)) |
| Chưa có `HoldExpiryJob` | Đơn quá hạn chưa thành `EXPIRED` | T3.4 |
| Ghi chú của chủ trọ khi từ chối chưa lưu | `viewings.note` là của người thuê | Cần cột mới nếu muốn lưu |
| Chưa kiểm chứng với payOS thử nghiệm thật | Cần khóa payOS và webhook (T3.4) | A chạy trên máy sau T3.4 |
| Một bản sao rental | Job sau này không chống chạy song song | Chốt 2026-11-16 |
| Test hạ tầng viết sau code | TDD chưa trọn ở tầng infra; bù: cố ý bỏ hủy lịch xem và điều kiện `PENDING_PAYMENT` trong handler → 2 test đỏ | tech-debt #21 |
