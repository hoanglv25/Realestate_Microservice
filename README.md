# Hệ thống thuê nhà microservices

> 💡 **Dành cho thành viên mới:** Xem [Hướng dẫn & Phân tích chi tiết hệ thống cho người mới bắt đầu](docs/HUONG_DAN_CHI_TIET_DU_AN.md) để nắm nhanh kiến trúc, nghiệp vụ và các công nghệ cốt lõi trong dự án.

Nền tảng thuê nhà: đặt cọc qua ví trung gian, chatbot gợi ý phòng. Toàn bộ service dùng
NestJS (TypeScript strict), pnpm workspace.

## Cấu trúc thư mục

```text
services/            # Các service NestJS (tạo ở GĐ2-4)
contracts/
  openapi/           # Hợp đồng REST nội bộ (OpenAPI 3.1), xem contracts/openapi/README.md
  events/            # JSON Schema của domain event, xem contracts/events/README.md
  scripts/           # Script kiểm tra contracts (pnpm contracts:check)
infra/
  compose/           # docker-compose + script khởi tạo
  elk/               # Cấu hình Elasticsearch/Kibana/Filebeat (GĐ10)
  rabbitmq/          # definitions.json, rabbitmq.conf
  k6/                # Kịch bản tải
  postman/           # Collection Postman
  scripts/           # Script kiểm tra/tiện ích hạ tầng
docs/
  architecture/      # Tài liệu kiến trúc
  adr/               # Architecture Decision Records
  runbook/           # Hướng dẫn vận hành
```

## Service và cổng

| Service      | Cổng | Ghi chú                                          |
| ------------ | ---- | ------------------------------------------------ |
| api-gateway  | 8080 |                                                  |
| identity     | 3001 | JWT RS256, [README](services/identity/README.md) |
| listing      | 3002 | gồm cả tính khoảng cách                          |
| rental       | 3003 |                                                  |
| payment      | 3004 |                                                  |
| notification | 3005 |                                                  |
| assistant    | 3006 | nếu còn thời gian                                |

`mobility` đã gộp vào listing, `maintenance` đã bỏ (xem
`project-knowledge/architecture.md`). Tài liệu dự án nằm ở `project-knowledge/` (cổng vào: `project-knowledge/CLAUDE.md`).

Mỗi service có DB riêng; không service nào đọc DB của service khác.

Tạo service mới bằng cách copy `services/_template-nest` (xem
[README của template](services/_template-nest/README.md)).

## Yêu cầu môi trường

- Node.js 22 LTS (xem `.nvmrc`). Trên Windows với nvm-windows, `nvm use 22` cần terminal
  chạy quyền Administrator (hoặc bật Developer Mode) để tạo symlink; chạy ở terminal thường
  sẽ treo và để lại máy không có `node` trên PATH.
- pnpm >= 10 (`corepack enable`)
- Docker Desktop + Docker Compose v2
- PowerShell (Windows) hoặc bash

## Cách chạy

```powershell
pnpm install
pnpm lint
pnpm format:check
pnpm contracts:check   # schema event và spec OpenAPI hợp lệ, khớp topology RabbitMQ
pnpm build
pnpm keys:generate     # một lần: tạo secrets/jwt-private.pem và jwt-public.pem (khóa ký JWT, không commit)
```

## Chạy hệ thống

Yêu cầu: Docker Desktop đang chạy. Lần đầu, tạo `.env` từ file mẫu (không commit `.env`):

```powershell
Copy-Item .env.example .env
```

Các lệnh dưới đây là script trong `package.json`, đã bọc sẵn `--env-file .env` và
`-f infra/compose/docker-compose.yml`:

```powershell
pnpm infra:up       # profile dev: Postgres, Redis, RabbitMQ (S3 là Cloudflare R2, email là SMTP thật trong .env; không có container)
pnpm infra:demo     # profile demo: dev + Elasticsearch + Kibana (http://127.0.0.1:5601)
pnpm infra:check    # kiểm tra toàn bộ hạ tầng, in OK/FAIL từng dòng (thoát 0 nếu tất cả OK)
pnpm infra:logs     # theo dõi log
pnpm infra:down     # dừng và gỡ container (dữ liệu trong volume được giữ)
```

Kiểm tra bằng bash (Git Bash, WSL, Linux, macOS): `bash infra/scripts/check-infra.sh`
(thêm `--demo` để bắt buộc kiểm tra Elasticsearch/Kibana). Bản PowerShell:
`powershell -NoProfile -ExecutionPolicy Bypass -File infra/scripts/check-infra.ps1`.

`rabbitmq-init` là tác vụ chạy một lần nên trạng thái đúng của nó là `Exited (0)`, không phải
`healthy`. Elasticsearch và Kibana được kiểm tra khi đang chạy, ngược lại script in `SKIP`.

**Reset toàn bộ dữ liệu dev** (xóa mọi volume của dự án: Postgres, Redis, RabbitMQ,
Elasticsearch; không thể hoàn tác; tệp trên R2 không bị xóa). Các script init DB và topology RabbitMQ sẽ chạy lại:

```powershell
docker compose --env-file .env -f infra/compose/docker-compose.yml --profile demo down -v
pnpm infra:up
pnpm infra:check
```

Chỉ reset riêng một thành phần: `pnpm infra:down` rồi `docker volume rm realestate_<tên>_data`
(`postgres`, `redis`, `rabbitmq`, `es`). Máy còn volume `realestate_s3_data` của Silo cũ thì xóa được: `docker volume rm realestate_s3_data`.

### Cổng kết nối: laptop và trong Docker

Hạ tầng chỉ publish cổng ra `127.0.0.1`. Có hai cách kết nối, đừng nhầm lẫn:

| Thành phần | Tiến trình chạy trên laptop        | Service chạy trong Docker  |
| ---------- | ---------------------------------- | -------------------------- |
| Postgres   | `localhost:5433` (`POSTGRES_PORT`) | `postgres:5432`            |
| Redis      | `localhost:6379`                   | `redis:6379`               |
| RabbitMQ   | `localhost:5672` (UI `15672`)      | `rabbitmq:5672`            |
| S3 (R2)    | `S3_ENDPOINT` trong `.env`         | `S3_ENDPOINT` (giống nhau) |

Postgres dùng cổng **5433** trên laptop vì máy đã cài PostgreSQL trên Windows chiếm 5432.
Container luôn lắng nghe 5432 bên trong; `POSTGRES_DOCKER_HOST` và `POSTGRES_DOCKER_PORT`
(`postgres` / `5432`) dành cho service chạy trong Docker.

### Khởi tạo database

- Postgres: `infra/compose/postgres/init/01-create-databases.sh` tạo `identity_db`, `listing_db`,
  `rental_db`, `payment_db`, `notification_db`, mỗi DB một user riêng (không phải superuser), `REVOKE CONNECT` từ
  PUBLIC nên user chỉ vào được DB của mình. `listing_db` bật `postgis`, `pgcrypto`, `uuid-ossp`.
- Không dùng MongoDB: notification cũng dùng Postgres (xem `project-knowledge/decisions/0008-bo-mongodb-notification-dung-postgresql.md`).
- Các script chỉ chạy **lần đầu** khi volume còn trống. Muốn chạy lại (sẽ mất dữ liệu dev):

```powershell
pnpm infra:down
docker volume rm realestate_postgres_data
pnpm infra:up
```

### RabbitMQ

- Topology nằm ở `infra/rabbitmq/definitions.json` (không chứa bí mật): exchange `domain.events`
  (topic) và `domain.events.dlx` (direct). Mỗi queue có DLQ `*.dlq`:

  | Queue                   | Service đọc  | Binding (routing key)                                                                              |
  | ----------------------- | ------------ | -------------------------------------------------------------------------------------------------- |
  | `rental.payment-events` | rental       | `payment.deposited`, `payment.refunded`, `payment.refund-rejected`, `payment.withdrawal-completed` |
  | `notification.events`   | notification | `identity.*`, `rental.*`, `payment.*`                                                              |

  Danh mục sự kiện: `project-knowledge/design/SHARED/RE.MESSAGING/API_Spec.md` §3.

  Schema event: `contracts/events/`. Đổi binding thì sửa cả `definitions.json` và danh sách mong
  đợi trong `infra/scripts/check-infra.*`.

- Không dùng `load_definitions`. RabbitMQ tạo user từ `.env` như bình thường, rồi container
  `rabbitmq-init` chạy một lần để POST topology vào Management API. Chạy lại nhiều lần vẫn an toàn.
  Trạng thái đúng của nó là `Exited (0)`.
- Áp dụng lại topology thủ công: `docker start -a re-rabbitmq-init`.
- Nếu sửa tham số của queue đã tồn tại (ví dụ `x-dead-letter-*`), RabbitMQ từ chối
  (`PRECONDITION_FAILED`). Khi đó xóa queue đó trong Management UI (`http://127.0.0.1:15672`) hoặc
  reset volume `realestate_rabbitmq_data` rồi chạy lại.
- Routing key có dạng hai từ `<miền>.<sự kiện>` (ví dụ `listing.created`); `*` chỉ khớp đúng một từ.
- Message bị `reject` không requeue sẽ vào `<queue>.dlq` (header `x-death` ghi lý do và routing key gốc).

### Object storage (S3)

Dev và production dùng **Cloudflare R2** qua API S3 (`project-knowledge/decisions/0016-object-storage-cloudflare-r2-bo-silo.md`),
không có container. Cần internet và khóa R2:

1. Bucket tạo tay trên dashboard R2 (riêng tư, Standard): `listing-images`, `payment-proofs`, `infra-test`.
   Service **không tự tạo bucket**; khởi động không gửi lệnh S3 nào, health `s3` kiểm bucket đầu tiên của `S3_BUCKETS`.
2. Token R2 quyền _Object Read & Write_ chỉ trên các bucket trên (không dùng quyền Admin).
3. CORS bucket `listing-images`: `AllowedMethods` `GET`, `PUT`, `HEAD`; `AllowedHeaders` `Content-Type`;
   `AllowedOrigins` gồm origin giao diện (local `http://localhost:3000`, thêm domain production khi deploy).
4. Điền `S3_ENDPOINT`, `S3_ACCESS_KEY`, `S3_SECRET_KEY`, `S3_REGION=auto` vào `.env` gốc (và `.env` của listing,
   payment khi chạy bằng `pnpm dev`); `S3_TEST_BUCKET=infra-test` để chạy test hạ tầng S3. Khóa thật không commit.

Trước go-live: reset **cùng lúc** database (`listings`, `listing_images`, `transfer_receipts`) và làm rỗng các bucket.

## Quy ước nhánh và commit

- Luồng nhánh: `main` <- `develop` <- `feature/*`.
- Mỗi tính năng làm trên `feature/<tên>` tách từ `develop`, mở PR vào `develop`.
- Commit theo Conventional Commits, ví dụ `chore(infra): ...`, `feat(listing): ...`, `fix(payment): ...`.
- Không commit `.env` hay bí mật thật; chỉ commit `.env.example`.
