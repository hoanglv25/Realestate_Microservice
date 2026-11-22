# @realestate/rental

Rental-service: lịch xem nhà, đơn đặt cọc, saga điều phối listing và payment. Cổng **3003**, DB `rental_db`, Redis (khóa theo tin, `Idempotency-Key`), RabbitMQ (phát `rental.*`, nghe queue `rental.payment-events`).
Dựng từ `services/_template-nest` nên dùng chung log JSON, correlation ID, định dạng lỗi, health check, `InternalHttpService`, outbox/consumer (đọc README của template cho các phần đó).

Thiết kế: `project-knowledge/design/RENTAL/RE.VIEWING/`, `RE.DEPOSIT_SAGA/`, `RE.DEPOSIT_LIFECYCLE/`. Giải thích code: `project-knowledge/guides/RE_Rental_Code_Walkthrough.md`.

## Chức năng (T3.2)

| Route (`/api/v1`)                   | Quyền            | Mô tả                                                                                                                                                  |
| ----------------------------------- | ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `POST /deposits`                    | TENANT           | Đặt cọc, bắt buộc `Idempotency-Key`: khóa Redis theo tin → bản chụp listing → giữ chỗ → đơn `PENDING_PAYMENT` → link payOS. Số tiền lấy từ tin (BR-04) |
| `POST /viewings`                    | TENANT           | Đặt lịch xem (không chọn giờ); `409` nếu đã có yêu cầu đang mở trên tin                                                                                |
| `POST /viewings/:id/respond`        | chủ tin          | Từ chối (`decision = DECLINE`)                                                                                                                         |
| `POST /viewings/:id/confirm-viewed` | người đặt        | `REQUESTED → CONFIRMED`                                                                                                                                |
| `POST /viewings/:id/cancel`         | người đặt        | `REQUESTED → CANCELLED`                                                                                                                                |
| `GET /viewings/mine`                | TENANT, LANDLORD | Người thuê: yêu cầu mình gửi; chủ trọ: yêu cầu trên tin mình. Lọc `listingId`, `status`; phân trang                                                    |

Sự kiện: phát `rental.deposit-created`, `rental.viewing-requested|responded|confirmed|cancelled` (qua outbox). Nghe `payment.deposited`: đơn `PENDING_PAYMENT → PAID`, đặt mốc 48h/72h, đánh dấu listing cần `DEPOSITED`, tự hủy yêu cầu xem `REQUESTED` của người khác trên tin.

Chưa có (theo kế hoạch): bù trừ khi tạo order lỗi, job đối soát và đồng bộ listing (T3.3), hết hạn giữ chỗ (T3.4), vòng đời đơn sau `PAID` (T3.5).

## Chạy

```powershell
pnpm infra:up                                            # postgres, redis, rabbitmq (ở gốc repo)
pnpm --filter @realestate/rental dev                     # tự tạo .env từ .env.example
pnpm --filter @realestate/rental migration:run           # lần đầu, và khi có migration mới
pnpm --filter @realestate/rental test                    # unit (listing, payment giả)
pnpm --filter @realestate/rental test:e2e                # e2e trong tiến trình (không cần hạ tầng)
pnpm --filter @realestate/rental test:infra              # Postgres + Redis + RabbitMQ thật; listing, payment là máy chủ giả theo hợp đồng
```

Trong Docker: `docker compose --env-file .env -f infra/compose/docker-compose.yml --profile dev --profile apps up -d --build rental`
(chạy migration từ host trước). Rental không publish cổng ra host, gọi qua gateway `8080`.

## Biến môi trường riêng

Bắt buộc (thiếu thì dừng khi khởi động, in rõ biến nào): `DATABASE_URL`, `REDIS_URL`, `RABBITMQ_URL`, `INTERNAL_LISTING_URL`, `INTERNAL_PAYMENT_URL`, `JWT_PUBLIC_KEY` hoặc `JWT_PUBLIC_KEY_PATH`, `JWT_ISSUER`.
Tùy chọn: `HOLD_TTL_SECONDS` (600), `DEPOSIT_LOCK_TTL_MS` (10000), `LISTING_CALL_TIMEOUT_MS` (2000), `PAYMENT_CALL_TIMEOUT_MS` (3000, `[cần đo]`), `REFUND_WINDOW_SECONDS` (172800), `AUTO_RELEASE_SECONDS` (259200), `RABBITMQ_QUEUE` (`rental.payment-events`). Chi tiết ở `.env.example`.

## Lưu ý

- Không transaction nào bao lời gọi HTTP. Đổi trạng thái là `UPDATE ... WHERE status = <cũ>`.
- Giữ chỗ ở listing **không** retry; tạo order ở payment được retry (idempotent theo `depositId`).
- Một bản sao rental (job sau này không dùng `FOR UPDATE SKIP LOCKED`, chốt 2026-11-16).
- Sửa phần kỹ thuật chung (`src/common`, `src/messaging`, ...) thì sửa `_template-nest` trước rồi chép sang (ADR-0014).
