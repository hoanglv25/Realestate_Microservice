# Hướng dẫn chạy Docker trên máy

> Nguồn: README gốc, `infra/compose/docker-compose.yml`, `services/_template-nest/README.md §6`. Lệnh viết cho PowerShell; bash tương tự.

| | |
|---|---|
| **Chủ sở hữu / Cập nhật** | hoang.lv — 2026-11-26 (T1.4: S3 chuyển sang Cloudflare R2, bỏ container Silo) |

## 1. Yêu cầu

| Công cụ | Phiên bản |
|---|---|
| Node.js | 22 LTS (`.nvmrc`) |
| pnpm | ≥ 10 (`corepack enable`) |
| Docker Desktop | Compose v2 |

## 2. Lần đầu

```powershell
pnpm install
Copy-Item .env.example .env       # không commit .env
pnpm keys:generate                # secrets/jwt-private.pem, jwt-public.pem
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"   # dán kết quả vào BANK_ACCOUNT_ENCRYPTION_KEY trong .env (một lần; identity cần khi chạy profile apps)
pnpm infra:up                     # profile dev: Postgres+PostGIS, Redis, RabbitMQ, Mailpit (S3 là R2, không có container)
pnpm infra:check                  # OK/FAIL từng thành phần
pnpm contracts:check
```

`rabbitmq-init` chạy một lần, trạng thái đúng là `Exited (0)`.

## 3. Profile

| Profile | Gồm | Lệnh |
|---|---|---|
| `dev` | Postgres, Redis, RabbitMQ, Mailpit (SMTP giả). S3 là Cloudflare R2 ngoài máy (ADR-0016) | `pnpm infra:up` |
| `demo` | `dev` + Elasticsearch, Kibana (`http://127.0.0.1:5601`) | `pnpm infra:demo` |
| `apps` | `identity`, `api-gateway` (thêm dần listing, rental, payment, notification) | Lệnh compose đầy đủ bên dưới; không có script `pnpm` riêng (chốt 2026-11-17) |

### 3.1 Chạy profile `apps`

Điều kiện trước khi `up` (làm một lần, hoặc khi đổi khóa/migration):

1. `secrets/jwt-private.pem`, `secrets/jwt-public.pem` có sẵn (`pnpm keys:generate`). Compose mount qua `secrets:` tại `/run/secrets/jwt_private_key` (chỉ identity) và `/run/secrets/jwt_public_key` (identity, gateway). Thiếu file thì `up` báo lỗi.
2. `BANK_ACCOUNT_ENCRYPTION_KEY` trong `.env` đã có giá trị (khóa AES-256-GCM, base64 của đúng 32 byte; sinh ở mục 2 "Lần đầu"). Để trống hoặc sai thì `re-identity` in lỗi rồi dừng. Giữ nguyên khóa: mất hoặc đổi thì số tài khoản nhận tiền đã lưu không giải mã được. Chạy identity ngoài Docker (`pnpm dev`) thì đặt cùng giá trị trong `services/identity/.env`.
3. Hạ tầng đang chạy (`pnpm infra:up`) và migration đã chạy từ laptop: `pnpm --filter @realestate/identity migration:run` (service để `migrationsRun=false`).

```powershell
docker compose --env-file .env -f infra/compose/docker-compose.yml --profile dev --profile apps up -d --build
docker compose --env-file .env -f infra/compose/docker-compose.yml --profile dev --profile apps ps   # re-identity, re-api-gateway: healthy
```

- Chỉ `api-gateway` publish `127.0.0.1:8080`; identity không publish cổng, chỉ gọi được qua gateway.
- Trong container, compose tự đặt `INTERNAL_*_URL` theo tên service (`http://identity:3001`…) và host hạ tầng (`postgres:5432`…); các biến `*_HOST`, `INTERNAL_*_URL`, `JWT_*_PATH` trong `.env` gốc chỉ dành cho tiến trình chạy trên laptop.
- Gateway khởi động sau khi identity `healthy` (healthcheck của ảnh chạy mỗi 30 giây, nên lần đầu có thể chờ tới ~30 giây).
- Gateway để `trust proxy=false`: mọi request ẩn danh từ laptop vào container mang IP của bridge, dùng chung một bộ đếm `RATE_LIMIT_IP` (100/60 giây). Đã chấp nhận (`RE.GATEWAY/Component_Class_Design.md §6`).

Kiểm chứng nhanh (đi qua gateway, cùng `X-Request-ID` ở hai log):

```powershell
curl.exe -i http://localhost:8080/health
curl.exe -i -X POST http://localhost:8080/api/v1/auth/register -H "Content-Type: application/json" -H "X-Request-ID: t13-trace-001" -d '{\"email\":\"t1@x.com\",\"password\":\"Matkhau@123\",\"fullName\":\"T1\",\"role\":\"TENANT\"}'
docker compose --env-file .env -f infra/compose/docker-compose.yml --profile apps logs api-gateway identity | Select-String t13-trace-001
curl.exe -i http://localhost:8080/internal/users/x    # 404 GATEWAY_ROUTE_NOT_FOUND
```

## 4. Cổng

| Thành phần | Trên laptop | Trong Docker |
|---|---|---|
| api-gateway | `127.0.0.1:8080` | `api-gateway:8080` |
| identity, listing, rental, payment, notification | 3001–3005 khi chạy `pnpm dev` | `<service>:<cổng>`, **không** publish khi chạy trong Docker |
| Postgres | `localhost:5433` | `postgres:5432` |
| Redis | `localhost:6379` | `redis:6379` |
| RabbitMQ | `localhost:5672`, UI `15672` | `rabbitmq:5672` |
| S3 (Cloudflare R2) | `S3_ENDPOINT` trong `.env` (cần internet, khóa R2) | Cùng `S3_ENDPOINT`; không đặt `S3_PUBLIC_ENDPOINT` |
| Mailpit | SMTP `localhost:1025`, giao diện `http://localhost:8025` | `mailpit:1025`; xem email OTP, đặt lại mật khẩu |

Hạ tầng chỉ publish ra `127.0.0.1`.

## 5. Dữ liệu và seed

| Việc | Lệnh |
|---|---|
| Migration một service | `pnpm --filter @realestate/<service> migration:run` |
| Tạo ADMIN | `$env:SEED_ADMIN_EMAIL='admin@example.com'; $env:SEED_ADMIN_PASSWORD='<≥12 ký tự>'; pnpm --filter @realestate/identity seed:admin` |
| Seed người dùng dev (chạy **trước** seed tin) | `$env:SEED_USER_PASSWORD='<≥12 ký tự>'; pnpm --filter @realestate/identity seed:users` |
| Seed tin đăng (cần `migration:run` của listing) | `pnpm --filter @realestate/listing seed:listings` |

Cả hai chạy lại an toàn (lần hai không đổi gì, không ghi đè tin đã sửa). Mật khẩu chỉ đặt qua biến tạm, không ghi vào `.env`. Muốn về dữ liệu gốc thì reset DB (§7).

**Id seed** (UUID cố định, dùng cho Postman và k6):

| Đối tượng | Id | Email (`@seed.realestate.local`) |
|---|---|---|
| Chủ trọ 1 · Nguyễn Văn Hùng | `a0000000-0000-4000-8000-000000000001` | `landlord1` |
| Chủ trọ 2 · Trần Thị Lan | `a0000000-0000-4000-8000-000000000002` | `landlord2` |
| Chủ trọ 3 · Lê Quang Minh | `a0000000-0000-4000-8000-000000000003` | `landlord3` |
| Người thuê 1–5 | `b0000000-0000-4000-8000-00000000000N`, N = 1…5 | `tenant1` … `tenant5` |
| Tin 1–30 | `c0000000-0000-4000-8000-0000000000NN`, NN = `01`…`30` | |

Chủ của tin NN: chủ trọ `((NN − 1) mod 3) + 1`. Tin theo khoảng cách tới điểm (lat 21.00, lng 105.84):

| Nhóm | Tin | Trạng thái |
|---|---|---|
| Trong 2 km | 01, 02, 04, 05, 07, 09, 10, 11, 12, 14, 15 | `AVAILABLE` + `APPROVED` (11 tin) |
| | 13 | `RENTED` + `APPROVED` |
| | 06, 08 | `PENDING_REVIEW` |
| | 03 | `HIDDEN` + `APPROVED` |
| 2,1–3 km | 16, 17, 18 | `AVAILABLE` + `APPROVED` |
| Xa hơn 3 km | 19, 20, 22, 23, 24, 25, 26, 27, 28, 30 | `AVAILABLE` + `APPROVED` (10 tin) |
| | 21 | `PENDING_REVIEW` |
| | 29 | `REJECTED` (có `rejectReason`) |

Route 11 quanh điểm trên với `radiusKm=2` trả 12 tin (11 `AVAILABLE` + tin 13 `RENTED`); `radiusKm=3` thêm 16, 17, 18. Không có tin `HELD`, `DEPOSITED` (cần đơn đặt cọc thật) và không có ảnh (tải qua API). Đăng nhập bằng email trên với mật khẩu `SEED_USER_PASSWORD` đã dùng khi seed.

## 6. Đặt cọc với payOS thật

payOS **không có môi trường thử riêng**: giao dịch là chuyển khoản thật, vào tài khoản ngân hàng đã liên kết với kênh thanh toán. Khi thử dùng tin có tiền cọc nhỏ (vài nghìn đồng). Gói miễn phí có giới hạn số đơn/tháng: thử các nhánh lỗi bằng webhook giả (dưới), không tạo link thật thừa.

1. Trên my.payos.vn: xác thực tổ chức (cá nhân, CCCD), liên kết tài khoản ngân hàng, tạo **kênh thanh toán**. Chép Client ID, API Key, Checksum Key vào `PAYOS_CLIENT_ID`, `PAYOS_API_KEY`, `PAYOS_CHECKSUM_KEY` trong `.env` (KHÔNG phải `.env.example`, không dán vào chat; `security-policy.md §1`).
2. Payment cần RabbitMQ (phát `payment.deposited` qua outbox): chạy profile `dev` trước, rồi `apps`.
3. Mở đường hầm tới gateway: `cloudflared tunnel --url http://localhost:8080` (hoặc `ngrok http 8080`). Địa chỉ đổi mỗi lần chạy lại.
4. Trên my.payos.vn, mục kênh thanh toán → Webhook URL: `https://<đường-hầm>/api/v1/payments/payos/webhook`. payOS gọi thử URL (`orderCode` 123, `reference` `TF230204212323`, chữ ký đúng): payment lưu lại với `IGNORED` (không phải giao dịch thành công) và trả `200`, nên URL được chấp nhận (đã thử 2026-11-22). Ô Webhook URL nằm ở **Kênh thanh toán → Cài đặt**; nút xoay cạnh Checksum Key tạo khóa mới (đổi thì cập nhật `.env` và dựng lại `payment`, **trước** khi khai URL). Khai lại mỗi khi đường hầm đổi địa chỉ.
5. Đặt cọc qua gateway, mở `checkoutUrl`, quét QR, trả đúng số tiền. Kiểm:

```powershell
$u = (Select-String .env -Pattern '^PAYMENT_DB_USER=(.*)').Matches[0].Groups[1].Value.Trim()
docker exec re-postgres psql -U $u -d payment_db -c "select order_code, reference, amount_vnd, result, received_at from payos_webhook_events order by received_at desc limit 5"
docker exec re-postgres psql -U rental_user -d rental_db -c "select status, paid_at from deposits order by created_at desc limit 1"
```

Demo hết hạn nhanh: `HOLD_TTL_SECONDS=60` (T3.4b).

### 6.1 Webhook giả có chữ ký (không trả tiền)

Ký `data` bằng `PAYOS_CHECKSUM_KEY` (đọc từ `.env` gốc) đúng thuật toán SDK payOS, gửi qua gateway như payOS:

```powershell
pnpm --filter @realestate/payment webhook:fake -- --order-code 100001 --amount 2000                       # hợp lệ -> PAID
pnpm --filter @realestate/payment webhook:fake -- --order-code 100001 --amount 2000 --reference <mã cũ>    # trùng -> DUPLICATE
pnpm --filter @realestate/payment webhook:fake -- --order-code 100001 --amount 2000 --bad-signature       # sai chữ ký
pnpm --filter @realestate/payment webhook:fake -- --order-code 100001 --amount 1000                       # sai số tiền
```

Tùy chọn khác: `--date "YYYY-MM-DD HH:mm:ss"` (giờ VN), `--failed` (`success=false`), `--url <url>` (mặc định `http://localhost:8080/api/v1/payments/payos/webhook`). Kết quả xem cột `result` ở bảng `payos_webhook_events` theo `reference` script in ra. Order đã hủy nhận webhook → `LATE` (`late_payments`, yêu cầu hoàn `SYSTEM`).

## 7. Reset

```powershell
pnpm infra:down                                       # giữ volume; dừng cả profile demo và apps
docker volume rm realestate_postgres_data             # chạy lại script init DB (mất dữ liệu)
docker compose --env-file .env -f infra/compose/docker-compose.yml --profile demo --profile apps down -v   # xóa mọi volume
```

Áp lại topology RabbitMQ: `docker start -a re-rabbitmq-init`. Đổi tham số queue đã có → xóa queue hoặc volume `realestate_rabbitmq_data`.

## 8. Dockerfile mỗi service

Build từ gốc repo: `docker build -f services/<service>/Dockerfile -t realestate/<service> .`. Ảnh 3 stage `node:22-alpine`, user `node`, `HEALTHCHECK` gọi `/health`, tắt gọn khi SIGTERM, không chứa `.env`.

## 9. Gỡ lỗi nhanh

| Triệu chứng | Kiểm tra |
|---|---|
| Service thoát ngay | Log in danh sách biến thiếu (`env.validation.ts`) |
| `503 AUTH_NOT_CONFIGURED` | Thiếu `JWT_PUBLIC_KEY_PATH` |
| `up` profile `apps` báo thiếu file secret | Chưa chạy `pnpm keys:generate` |
| Gateway trả `503 UPSTREAM_UNAVAILABLE` | Service đích chưa chạy hoặc chưa `healthy` (`docker compose ... ps`) |
| Đăng ký lỗi 500 ngay sau `up` | Chưa chạy `migration:run` của identity (T2.5 thêm cột `users.status`, `phone`...) |
| Đăng ký xong không thấy email OTP | Mailpit chạy chưa (`docker ps` có `re-mailpit`); thư gửi nền nên có thể trễ vài trăm ms; xem log identity có dòng `Gửi email thất bại` (lỗi `warn`) |
| `POST /auth/google` trả 503 | `GOOGLE_CLIENT_ID` trống (đúng thiết kế khi chưa cấu hình Google) |
| Identity dừng khi `pnpm dev` báo thiếu `SMTP_HOST`, `MAIL_FROM` | `services/identity/.env` cũ chưa có hai biến này: chép từ `services/identity/.env.example` |
| `DEPENDENCY_UNAVAILABLE` | `pnpm infra:check`; trên laptop dùng cổng 5433 |
| Consumer không nhận | Queue có binding chưa (`definitions.json`), `RABBITMQ_URL` có `%2F` |
| Presigned URL không mở được, upload từ trình duyệt lỗi CORS | CORS bucket `listing-images` có origin giao diện (`GET`, `PUT`, `HEAD`, header `Content-Type`); URL hết hạn sau `S3_PRESIGN_TTL_SECONDS` |
| `/health` báo `s3` down | Ngay sau khi khởi động, mạng chậm: lần gọi R2 đầu (DNS + TLS) có thể vượt giới hạn 2 giây của health check, gọi lại sau vài giây. Vẫn down: `S3_ENDPOINT`, khóa R2 sai hoặc token bị thu hồi, token thiếu quyền trên bucket đầu của `S3_BUCKETS`, bucket chưa tạo trên R2 (service không tự tạo) |
| Webhook không tới | Đường hầm còn chạy, URL trong trang payOS đúng (đổi mỗi lần chạy lại đường hầm); `payos_webhook_events` có dòng mới chưa |
| Webhook tới nhưng đơn không `PAID` | `result` của webhook (`INVALID_SIGNATURE`: sai `PAYOS_CHECKSUM_KEY`; `AMOUNT_MISMATCH`: trả sai số tiền); RabbitMQ chạy chưa (`payment.deposited` nằm ở `outbox_events` chưa `published_at`) |
| Theo một request | Lọc log theo `correlationId` |

Xem thêm `standards/gotchas.md`.
