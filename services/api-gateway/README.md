# @realestate/template-nest

Template service NestJS dùng chung cho monorepo `Realestate_Microservice`. Mọi service (api-gateway,
identity, listing, rental, payment, notification, assistant) **copy từ đây**, nên template đã có sẵn
các quy ước bắt buộc: log JSON, correlation ID, định dạng lỗi thống nhất, health check, JWT/roles,
idempotency, HTTP client gọi service khác, publish/consume event qua RabbitMQ (outbox, inbox, DLQ),
object storage S3 (presigned URL, bucket tạo sẵn), Swagger và Dockerfile.

- NestJS **11.2.8** (CommonJS), TypeScript strict, Node 22 LTS, pnpm workspace.
- Chạy được ngay, **không cần DB, Redis, RabbitMQ hay S3**: `DATABASE_URL`/`REDIS_URL`/`RABBITMQ_URL`/
  `S3_ENDPOINT` chỉ bật module tương ứng khi có.
- Không có code nghiệp vụ. Thư mục `src/example/` là module **mẫu** để học cách dùng, xóa khi tạo service thật.

## Chạy thử template

```powershell
pnpm install                                     # ở gốc repo
pnpm --filter @realestate/template-nest dev      # tự tạo .env từ .env.example nếu chưa có
```

Mở `http://localhost:3000/api/v1/health` (hoặc `/health`) và Swagger tại `http://localhost:3000/api/docs`.

## 1. Tạo service mới từ template (trong 10 phút)

Ví dụ tạo `identity` (cổng 3001, DB `identity_db`). Chạy ở **gốc repo**, bằng PowerShell:

```powershell
# 1) Copy, bỏ node_modules/dist/.env (robocopy trả mã 1 nghĩa là copy thành công)
robocopy services\_template-nest services\identity /E /XD node_modules dist /XF .env openapi.json | Out-Null

# 2) Đổi tên package (name, description), SERVICE_NAME + PORT trong .env.example, thư mục trong Dockerfile
#    (ghi UTF-8 không BOM để tiếng Việt và .env không bị hỏng)
$utf8 = New-Object Text.UTF8Encoding($false)
function Edit-File($path, $pairs) {
  $t = [IO.File]::ReadAllText($path)
  foreach ($p in $pairs) { $t = $t.Replace($p[0], $p[1]) }
  [IO.File]::WriteAllText($path, $t, $utf8)
}
Edit-File 'services\identity\package.json' @(
  @('@realestate/template-nest', '@realestate/identity'),
  @('Template service NestJS dùng chung cho monorepo Realestate_Microservice', 'Identity service: đăng ký, đăng nhập, phát hành JWT'))
Edit-File 'services\identity\.env.example' @(
  @('SERVICE_NAME=template-nest', 'SERVICE_NAME=identity'), @('PORT=3000', 'PORT=3001'))
Edit-File 'services\identity\Dockerfile' @(
  @('services/_template-nest', 'services/identity'), @('template-nest', 'identity'))

# 3) Cài phụ thuộc và chạy (pnpm dev tự tạo .env từ .env.example)
pnpm install
pnpm --filter @realestate/identity dev
```

Kiểm tra: `curl.exe http://localhost:3001/api/v1/health` trả `{"status":"ok","service":"identity",...}`.

Việc cần làm tiếp để thành service thật:

1. Xóa module mẫu (đã kiểm chứng: sau khi xóa, `build`, `test` và `test:e2e` vẫn xanh): thư mục `src/example/`,
   dòng `ExampleModule` (và import của nó) trong `src/app.module.ts`, `test/example.e2e-spec.ts`, và entity +
   migration mẫu trong `src/database/` (`entities/example-item.entity.ts`,
   `migrations/1730000000000-create-example-item.ts`; không file nào khác tham chiếu tới chúng). Giữ lại
   các `test/*.e2e-spec.ts` và `src/**/*.spec.ts` còn lại: chúng kiểm tra hạ tầng dùng chung.
2. Bật DB: bỏ comment `DATABASE_URL` trong `.env`, đổi sang user/DB của service (bảng bên dưới).
3. Viết module nghiệp vụ trong `src/<tên-module>/`, mã lỗi nghiệp vụ riêng khai báo trong module đó.
4. Thêm vào `docker-compose` (xem mục [Docker](#docker)) và thêm file OpenAPI vào `contracts/openapi/`.

### Bảng cổng và DB

| Service      | Cổng | Database (Postgres, user riêng cùng tên miền) |
| ------------ | ---- | --------------------------------------------- |
| template     | 3000 | không                                         |
| api-gateway  | 8080 | không                                         |
| identity     | 3001 | `identity_db` / `identity_user`               |
| listing      | 3002 | `listing_db` / `listing_user` (có PostGIS)    |
| rental       | 3003 | `rental_db` / `rental_user`                   |
| payment      | 3004 | `payment_db` / `payment_user`                 |
| notification | 3005 | `notification_db` / `notification_user`       |
| assistant    | 3006 | không (chỉ gọi API của listing)               |

Mỗi service **chỉ** được kết nối DB của mình, không đọc DB của service khác. Từ laptop, Postgres ở
`localhost:5433`; trong Docker dùng host `postgres` cổng `5432` (xem README gốc).

## 2. Quy ước mà template thể hiện

| Chủ đề         | Quy ước                                                                                                                                                                                                     |
| -------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| API công khai  | Prefix `/api/v1`.                                                                                                                                                                                           |
| API nội bộ     | Prefix `/internal/...`, chỉ service gọi service, **gateway không expose**, không có trong Swagger.                                                                                                          |
| Health         | `GET /health` (cho Docker) và alias `GET /api/v1/health`. Body `{ status, service, version, uptime, checks }`, 200 khi ổn, 503 khi phụ thuộc chết.                                                          |
| Response       | Thành công: `{ data, meta }`. Lỗi: `{ error: { code, message, details? }, meta }`. `meta` luôn có `correlationId`, `timestamp`; danh sách phân trang thêm `page, pageSize, total, totalPages`. Xem mục 2.1. |
| Lỗi            | Mã lỗi nằm trong `error.code`. 4xx nghiệp vụ, 503/504 hạ tầng, 5xx không lộ stack/message.                                                                                                                  |
| Correlation ID | Đọc header `X-Request-ID` (gateway sinh), thiếu thì tự sinh UUID v4. Có ở response header, mọi dòng log, và tự truyền khi gọi service khác.                                                                 |
| Log            | JSON một dòng ra stdout: `level, time (ISO UTC), service, correlationId, msg` (+ `method, url, statusCode, responseTime` cho request).                                                                      |
| Tiền           | **Số nguyên VND** (`bigint` trong DB, `@IsInt()` trong DTO). Không bao giờ dùng float/decimal.                                                                                                              |
| Thời gian      | Luôn UTC, ISO-8601 (`2026-11-05T10:00:00.000Z`); cột DB là `timestamptz`.                                                                                                                                   |
| Validation     | `ValidationPipe` toàn cục: bỏ trường thừa → báo lỗi (`forbidNonWhitelisted`), tự ép kiểu.                                                                                                                   |

### 2.1 Khung response `{ data, meta }`

`ResponseEnvelopeInterceptor` (đăng ký toàn cục ở `app.module.ts`) bọc kết quả của mọi controller; controller và
service vẫn chỉ trả dữ liệu thuần. Lỗi do `AllExceptionsFilter` dựng với cùng `meta`.

```jsonc
// 200/201
{ "data": { "id": "…" }, "meta": { "correlationId": "abc-123", "timestamp": "2026-11-06T10:00:00.000Z" } }

// danh sách: handler trả `new Paginated(items, page, pageSize, total)`
{ "data": [ … ], "meta": { "correlationId": "…", "timestamp": "…", "page": 1, "pageSize": 20, "total": 134, "totalPages": 7 } }

// lỗi
{ "error": { "code": "EXAMPLE_NAME_TAKEN", "message": "…", "details": { } }, "meta": { "correlationId": "…", "timestamp": "…" } }
```

- **Không bọc**: `/health` (gắn `@RawResponse()`: Docker HEALTHCHECK đọc body phẳng), route `@HttpCode(204)`, `StreamableFile`.
- Handler không trả gì mà status 200/201 thì `data: null`.
- Swagger: dùng `@ApiEnvelope(Dto)` hoặc `@ApiEnvelope(Dto, { isArray: true, status: HttpStatus.CREATED })` thay cho
  `@ApiOkResponse({ type })`; lỗi dùng `ErrorResponseDto` như cũ.
- `InternalHttpService` gọi service khác tự lấy `data` khi thành công và đọc `error` khi lỗi, nên code gọi vẫn nhận DTO thuần.
  Lỗi hạ tầng `503/504` kèm `details.outcome`: `NOT_EXECUTED` khi chưa gửi được request (`ECONNREFUSED`, `ENOTFOUND`), còn lại `UNKNOWN` (có thể đã chạy ở đích), để saga biết có cần đối soát.
- Idempotency: kết quả lưu là dữ liệu thuần; replay vẫn được bọc với `meta` của request mới.

### Lỗi: cách ném và mã lỗi

```ts
throw new AppException('DEPOSIT_ALREADY_PAID', 'Đơn đặt cọc đã được thanh toán', 409, {
  depositId,
});
```

Mã dùng chung (xem `src/common/errors/error-codes.ts`): `VALIDATION_FAILED` (400), `AUTH_TOKEN_MISSING|INVALID|EXPIRED` (401),
`FORBIDDEN_ROLE` (403), `NOT_FOUND` (404), `CONFLICT` (409), `IDEMPOTENCY_KEY_REUSED` (422),
`IDEMPOTENCY_IN_PROGRESS` (409), `INTERNAL_ERROR` (500), `DEPENDENCY_UNAVAILABLE`/`UPSTREAM_UNAVAILABLE` (503),
`DEPENDENCY_TIMEOUT`/`UPSTREAM_TIMEOUT` (504). Mã nghiệp vụ riêng đặt tên `<MIỀN>_<LÝ_DO>` trong module của service.

## 3. Cấu trúc thư mục

```text
src/
├── main.ts                 # bootstrap: nạp env, logger, Swagger, shutdown hooks
├── app.module.ts           # ghép module; DB/Redis/RabbitMQ/S3 chỉ bật khi có env
├── app.setup.ts            # prefix, middleware (dùng chung main.ts và test)
├── swagger.setup.ts        # Swagger UI /api/docs và dựng OpenAPI
├── config/                 # đọc + validate biến môi trường (Joi)
├── common/                 # phần dùng chung, xem bên dưới
├── health/                 # GET /health (Terminus) + HealthRegistry
├── database/               # TypeORM (TÙY CHỌN): module, entity mẫu, migration, data-source CLI
├── redis/                  # ioredis (TÙY CHỌN)
├── messaging/              # RabbitMQ (TÙY CHỌN, cần DB): outbox, relay, consumer + inbox
├── storage/                # S3 (TÙY CHỌN): StorageService, presigned URL (bucket tạo sẵn)
├── example/                # module MẪU: xóa khi tạo service thật
└── scripts/export-openapi.ts
test/                       # test e2e + helper (createTestApp, upstream giả, expectEventMatchesContract)
                            # *.infra-spec.ts: test với hạ tầng thật (pnpm test:infra)
```

### `src/common/` làm gì

| Thư mục        | Nội dung và khi nào dùng                                                                                                                                                                                                                        |
| -------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `errors/`      | `AppException` (ném lỗi chuẩn), `error-codes.ts` (mã dùng chung), `AllExceptionsFilter` (đưa MỌI lỗi về một format, giấu stack ở 5xx, đổi lỗi kết nối DB/Redis thành 503/504), `createValidationPipe` (lỗi DTO kèm `details` theo từng trường). |
| `logging/`     | `logger.module.ts` (pino, JSON, ẩn `authorization`/`cookie`/`password`...), `correlation-id.middleware.ts` (X-Request-ID, `getCorrelationId()` dùng ở mọi nơi), `access-log.middleware.ts` (một dòng log mỗi request).                          |
| `auth/`        | `JwtAuthGuard` (mặc định mọi route cần JWT), `JwtTokenVerifier` (kiểm chữ ký, hạn, `iss`, claims; guard riêng của service gọi lại được), `RolesGuard`, `@Public()`, `@Roles('ADMIN',...)`, `@CurrentUser()`, `jwt.config.ts` (chọn khóa).       |
| `idempotency/` | `@Idempotent()` + interceptor: chống xử lý trùng cho thao tác ghi quan trọng (đặc biệt tiền). Cần Redis.                                                                                                                                        |
| `http/`        | `InternalHttpService`: gọi service khác với timeout, retry an toàn, truyền `X-Request-ID`, đổi lỗi thành `AppException`.                                                                                                                        |
| `lifecycle/`   | `ShutdownLoggerService`: ghi log trình tự tắt gọn khi nhận SIGTERM.                                                                                                                                                                             |

### Dùng nhanh

```ts
@Controller('deposits')
export class DepositController {
  constructor(private readonly http: InternalHttpService) {}

  @Public()
  @Get('health-ish') // không cần token
  open() {}

  @Roles('ADMIN')
  @Get('admin') // cần ADMIN (403 FORBIDDEN_ROLE nếu thiếu)
  admin(@CurrentUser('sub') adminId: string) {}

  @Post()
  @Idempotent() // client gửi header Idempotency-Key, cần REDIS_URL
  async create(@Body() dto: CreateDepositDto) {
    // Gọi service khác: tự gắn X-Request-ID, GET được retry, 4xx của đích giữ nguyên
    const room = await this.http.get<RoomDto>(
      `${process.env.INTERNAL_LISTING_URL}/internal/rooms/${dto.roomId}`,
    );
  }
}
```

`@Roles` nhận **chuỗi tự do**, template không cố định danh sách vai trò (identity-service sẽ quy định, ví dụ
`ADMIN`, `LANDLORD`, `TENANT`).

### Messaging: publish và consume event

Bật bằng `RABBITMQ_URL` + `DATABASE_URL`, và chạy migration `CreateMessagingTables` (bảng `outbox_events`,
`processed_events`). Hợp đồng event nằm ở `contracts/events/` gốc repo.

**Publish**: ghi event vào outbox **trong cùng transaction** với thay đổi dữ liệu. `OutboxRelay` gửi lên
RabbitMQ sau khi commit, nên không bao giờ có cảnh "DB đã lưu mà event mất" hoặc ngược lại.

```ts
constructor(private readonly dataSource: DataSource, private readonly outbox: OutboxService) {}

async create(dto: CreateDepositDto) {
  return this.dataSource.transaction(async (manager) => {
    const d = await manager.save(Deposit, { ...dto, status: 'PENDING_PAYMENT' });
    await this.outbox.add(manager, 'rental.deposit-created', { depositId: d.id, /* ... */ });
    return d;
  });
}
```

**Consume**: đặt `RABBITMQ_QUEUE` (ví dụ `rental.payment-events`) rồi đăng ký handler. Consumer tự chống xử
lý trùng theo `eventId` (bảng `processed_events`, cùng transaction với handler), thử lại khi lỗi, quá số lần
thì đẩy vào `<queue>.dlq`. Event có trên queue mà không có handler thì bỏ qua.

```ts
@Injectable()
export class PaymentEventsHandler implements OnModuleInit {
  constructor(
    private readonly events: EventHandlerRegistry,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(PaymentEventsHandler.name);
  }

  onModuleInit() {
    this.events.on<{ depositId: string }>('payment.deposited', async (event, manager) => {
      // Mọi thay đổi dùng `manager` (cùng transaction với inbox). Kiểm tra trạng thái hiện tại trước.
      const moved = await manager.update(
        Deposit,
        { id: event.payload.depositId, status: 'PENDING_PAYMENT' },
        { status: 'PAID' },
      );
      if (moved.affected === 0) {
        // Đơn không còn PENDING_PAYMENT (sự kiện đến muộn hoặc lặp): không đổi gì, chỉ ghi log
        this.logger.warn({ depositId: event.payload.depositId }, 'payment.deposited bỏ qua');
      }
    });
  }
}
```

- Biết chắc thử lại vô ích (dữ liệu sai): ném `NonRetryableEventError`, message vào DLQ ngay.
- Log trong handler tự mang `correlationId` của request gốc; event phát tiếp từ handler cũng giữ nguyên nó.
- Test payload đúng contract: `expectEventMatchesContract(event)` trong `test/helpers/contracts.ts`.
- Mẫu đầy đủ (publish, consume, chống trùng, DLQ) chạy với hạ tầng thật: `test/messaging.infra-spec.ts`.
- Service **không** tự tạo exchange/queue. Thêm queue thì sửa `infra/rabbitmq/definitions.json`.

### Object storage (S3)

Bật bằng `S3_ENDPOINT` + `S3_ACCESS_KEY` + `S3_SECRET_KEY`. Kho là Cloudflare R2
(`project-knowledge/decisions/0016-object-storage-cloudflare-r2-bo-silo.md`). Service **không tạo bucket**: bucket trong
`S3_BUCKETS` phải có sẵn (tạo tay trên dashboard R2); khởi động không gửi lệnh S3 nào, health `s3` kiểm bucket đầu tiên.
Gateway không dùng S3.

Upload ảnh từ trình duyệt nên đi thẳng lên S3, không qua service:

```ts
// 1. Client xin URL upload; service quyết định key (không để client tự đặt key)
const key = `listings/${listingId}/${randomUUID()}.jpg`;
const uploadUrl = await this.storage.presignPut('listing-images', key, 'image/jpeg');
// 2. Client: PUT uploadUrl với header Content-Type: image/jpeg (sai loại file thì S3 trả 403)
// 3. Client báo xong; service lưu `key` vào DB. Lúc hiển thị:
const viewUrl = await this.storage.presignGet('listing-images', key);
```

- Content-Type được ký vào URL, nên client không đổi được loại file. Kích thước file thì presigned PUT
  **không** giới hạn được: kiểm tra bằng HeadObject trước khi chấp nhận key.
- Lưu **key** trong DB, không lưu URL (URL hết hạn sau `S3_PRESIGN_TTL_SECONDS`).
- File nhỏ do service tự tạo (ví dụ ảnh QR): `storage.putObject(bucket, key, buffer, contentType)`.

## 4. Biến môi trường

Validate khi khởi động (`src/config/env.validation.ts`): thiếu biến bắt buộc hoặc sai định dạng thì service
**dừng ngay** và in rõ biến nào sai.

| Biến                      | Mặc định        | Ý nghĩa                                                                                                                              |
| ------------------------- | --------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `SERVICE_NAME`            | **không**       | Tên service (log, `/health`, Swagger). **Bắt buộc.**                                                                                 |
| `NODE_ENV`                | `development`   | `development` \| `test` \| `production`                                                                                              |
| `PORT`                    | `3000`          | Cổng HTTP.                                                                                                                           |
| `LOG_LEVEL`, `LOG_PRETTY` | `info`, `false` | Mức log; `LOG_PRETTY=true` bật pino-pretty (chỉ dev).                                                                                |
| `HTTP_TIMEOUT_MS`         | `3000`          | Timeout gọi service khác. `.env.example` gốc repo cũng `3000` (A2).                                                                  |
| `HTTP_MAX_RETRIES`        | `2`             | Số lần thử lại tối đa (chỉ GET/lệnh idempotent).                                                                                     |
| `SWAGGER_ENABLED`         | `true`          | Bật `/api/docs`. Ảnh Docker mặc định `false`.                                                                                        |
| `IDEMPOTENCY_TTL_SECONDS` | `86400`         | Thời gian lưu kết quả `Idempotency-Key`.                                                                                             |
| `DATABASE_URL`            | tắt             | Bật TypeORM + health `db`. Ví dụ laptop: `postgres://identity_user:change_me_identity@localhost:5433/identity_db`.                   |
| `REDIS_URL`               | tắt             | Bật Redis + health `redis`. Ví dụ: `redis://:change_me_redis@localhost:6379`.                                                        |
| `RABBITMQ_URL`            | tắt             | Bật MessagingModule + health `rabbitmq`. **Bắt buộc kèm `DATABASE_URL`**. vhost `/` phải viết `%2F`.                                 |
| `RABBITMQ_EXCHANGE`       | `domain.events` | Exchange publish event.                                                                                                              |
| `RABBITMQ_QUEUE`          | tắt             | Queue service đọc (có trong `infra/rabbitmq/definitions.json`). Bỏ trống = chỉ publish.                                              |
| `RABBITMQ_PREFETCH`       | `10`            | Số message xử lý song song tối đa.                                                                                                   |
| `RABBITMQ_MAX_RETRIES`    | `3`             | Số lần thử lại khi handler lỗi, sau đó message vào `<queue>.dlq`.                                                                    |
| `OUTBOX_POLL_INTERVAL_MS` | `1000`          | Chu kỳ quét outbox để publish.                                                                                                       |
| `OUTBOX_BATCH_SIZE`       | `50`            | Số event tối đa mỗi lần quét.                                                                                                        |
| `OUTBOX_RELAY_ENABLED`    | `true`          | `false`: event vẫn ghi vào outbox nhưng relay không tự gửi (dùng khi test).                                                          |
| `S3_ENDPOINT`             | tắt             | Bật StorageModule + health `s3`. Bắt buộc kèm `S3_ACCESS_KEY`, `S3_SECRET_KEY`. R2: `https://<ACCOUNT_ID>.r2.cloudflarestorage.com`. |
| `S3_PUBLIC_ENDPOINT`      | = `S3_ENDPOINT` | Host ghi vào presigned URL, chỉ đặt khi khác `S3_ENDPOINT`. R2: để trống.                                                            |
| `S3_BUCKETS`              | trống           | Bucket có sẵn, cách nhau dấu phẩy, ví dụ `listing-images`. Bucket đầu cho health check.                                              |
| `S3_REGION`               | `us-east-1`     | Region cho AWS SDK. R2: `auto`.                                                                                                      |
| `S3_FORCE_PATH_STYLE`     | `true`          | Dạng `endpoint/bucket`; R2 chạy được với `true`.                                                                                     |
| `S3_PRESIGN_TTL_SECONDS`  | `900`           | Thời hạn presigned URL.                                                                                                              |
| `JWT_PUBLIC_KEY`          | tắt             | Khóa công khai PEM (xuống dòng viết `\n`), RS256. Ưu tiên 1.                                                                         |
| `JWT_PUBLIC_KEY_PATH`     | tắt             | Đường dẫn file khóa công khai, RS256. Ưu tiên 2.                                                                                     |
| `JWT_SECRET`              | tắt             | Bí mật HS256 (≥16 ký tự, **chỉ dev**). Ưu tiên 3.                                                                                    |
| `JWT_ISSUER`              | tắt             | Nếu đặt, token phải có đúng `iss`.                                                                                                   |

Không cấu hình JWT nào thì mọi route không `@Public()` trả `503 AUTH_NOT_CONFIGURED` (không bao giờ để hở).

## 5. Lệnh thường dùng

```powershell
pnpm --filter @realestate/template-nest dev              # chạy, tự build lại khi sửa
pnpm --filter @realestate/template-nest build            # biên dịch ra dist/
pnpm --filter @realestate/template-nest test             # unit test (config, correlation ID, idempotency)
pnpm --filter @realestate/template-nest test:e2e         # test e2e (không cần hạ tầng)
pnpm --filter @realestate/template-nest test:infra       # test với Postgres + RabbitMQ + S3 thật (cần pnpm infra:up)
pnpm --filter @realestate/template-nest openapi:export   # xuất openapi.json để so với contracts/openapi
pnpm lint                                                # ở gốc repo
```

Migration (cần `DATABASE_URL`): `pnpm migration:generate src/database/migrations/<tên>`,
`pnpm migration:run`, `pnpm migration:revert`. `synchronize` luôn tắt, schema chỉ đổi qua migration.
UUID dùng `gen_random_uuid()` của PostgreSQL (TypeORM `uuidExtension: 'pgcrypto'`), không cần extension `uuid-ossp`.

### Kiểm tra từng tiêu chí

```powershell
curl.exe http://localhost:3000/api/v1/health                                   # 200 + { status, service, version, uptime, checks } (body phẳng, không bọc)
curl.exe -i http://localhost:3000/api/v1/examples/0b0a8b5e-7f9e-4c3a-9d2a-2f5f4b9c1a11 -H "X-Request-ID: abc-123"
                                                                               # 404 { error: { code, message, details }, meta: { correlationId: "abc-123", timestamp } } và header X-Request-ID: abc-123
pnpm lint; pnpm --filter @realestate/template-nest test:e2e                    # xanh
docker build -f services/_template-nest/Dockerfile -t realestate/template-nest .
```

## 6. Docker

Build từ **gốc repo** (ảnh cần `pnpm-lock.yaml` và `tsconfig.base.json`); `Dockerfile.dockerignore` nằm cạnh Dockerfile
(BuildKit ưu tiên file này vì build context là gốc repo):

```powershell
docker build -f services/identity/Dockerfile -t realestate/identity .
docker run --rm -p 3001:3001 -e SERVICE_NAME=identity -e PORT=3001 realestate/identity
```

Ảnh: 3 stage, `node:22-alpine`, chạy bằng user `node` (không phải root), `HEALTHCHECK` gọi `/health`,
tắt gọn khi nhận SIGTERM, mặc định `SWAGGER_ENABLED=false`, **không** chứa `.env`/devDependencies.

Thêm vào `infra/compose/docker-compose.yml` (dùng chung network và biến `.env` gốc; trong Docker dùng host `postgres:5432`,
`redis:6379`):

```yaml
identity:
  build:
    context: ../..
    dockerfile: services/identity/Dockerfile
  container_name: re-identity
  profiles: [apps]
  environment:
    SERVICE_NAME: identity
    PORT: '3001'
    DATABASE_URL: postgres://${IDENTITY_DB_USER}:${IDENTITY_DB_PASSWORD}@postgres:5432/${IDENTITY_DB_NAME}
    REDIS_URL: redis://:${REDIS_PASSWORD}@redis:6379
    # Chọn MỘT: JWT_SECRET (HS256, chỉ dev) hoặc mount khóa công khai vào container rồi đặt JWT_PUBLIC_KEY_PATH
    JWT_SECRET: ${JWT_SECRET_DEV:-bi-mat-dev-toi-thieu-16-ky-tu}
  ports:
    - '127.0.0.1:3001:3001'
  depends_on:
    postgres: { condition: service_healthy }
    redis: { condition: service_healthy }
  networks: [realestate-net]
```

## 7. Lưu ý và khác biệt so với giả định ban đầu

- **NestJS 11, không phải 12**: bản `latest` (12.x) là ESM-only, còn `tsconfig.base.json` của repo là CommonJS.
- **`incremental` tắt** trong `tsconfig.json` của template: `.tsbuildinfo` nằm ngoài `dist/` nên `nest build` bỏ sót file khi `dist/` bị xóa.
- **Middleware gắn bằng `app.use`** (xem `app.setup.ts`): middleware của module bị Nest gắn thêm prefix `/api/v1`,
  nên bỏ sót `/health`, `/internal/*` và các request 404.
- **`/health` có hai đường dẫn**: `/health` (Docker, không qua gateway) và `/api/v1/health` (alias).
- **ConfigModule bỏ qua file `.env`**: `env.bootstrap.ts` nạp file; test e2e vì vậy không đọc `.env` cục bộ.
- **`amqp-connection-manager` ghim 5.0.0**: bản 5.0.1 kéo `promise-breaker` 7 (chỉ có ESM) vào bản CommonJS, Jest
  không nạp được. Nâng cấp khi thư viện sửa lỗi này.
- **Inject `PinoLogger` trực tiếp** rồi `setContext(...)`; đừng dùng `@InjectPinoLogger` (chỉ chạy nếu class được import
  trước `LoggerModule`).
- **Giới hạn ẩn log**: các trường nhạy cảm (`authorization`, `cookie`, `password`, `token`, `secret`...) được ẩn ở độ sâu
  tối đa 3 cấp; lỗi của axios được lược `config`/`request`/`response` để không lộ header `Authorization`.
  Đừng log nguyên object lớn, chỉ log các trường cần thiết.
- **`/internal/*` đang `@Public()`**: tạm tin mạng nội bộ; nên thêm xác thực service-to-service khi triển khai thật.
- **`ConfigModule` chốt giá trị lúc import `AppModule`**: test đổi biến có giá trị mặc định (ví dụ `HTTP_TIMEOUT_MS`) phải
  đặt env **trước** khi import (xem `test/http-client-defaults.e2e-spec.ts`).
