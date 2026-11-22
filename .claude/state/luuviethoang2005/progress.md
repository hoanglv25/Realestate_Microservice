---
task: T3.4a Webhook payOS, ghi nhận đặt cọc, tiền đến muộn
updated: 2026-11-22
percent: 95
---

## Đang làm
- Bước hiện tại: code, test, tài liệu, review xong; chờ A chạy `test:infra` đủ bộ trên máy, dựng lại `payment`, chặng C (payOS thật), rồi commit + PR

## Đã xong (phiên này)
- Chặng A: link payOS thật qua gateway (`orderCode` 100000, 2.000đ)
- T3.2 merge (PR #27), tick `implementation/progress.md`; tách T3.4 → T3.4a/T3.4b
- `PayosClient.verify`, `WebhookService`, `DepositCaptureService`, `WalletService.credit`, `PayosWebhookController`, script `webhook:fake`
- payment unit 191, e2e 97, infra `payos-webhook` 12 + `payment-orders` 23; lint, format, build, contracts sạch; chạy thật `node dist/main.js` + script
- A chạy `test:infra` 49/49 trên máy (có `messaging`, `storage`)
- `RE.PAYMENT` v1.3, walkthrough, Docker guide §6, `CLAUDE.md §2.5`; compose + `.env.example` (RabbitMQ cho payment)

## Còn lại
- Commit (không dòng ghi công AI), push, PR; sau merge tick `implementation/progress.md` T3.4a

## Blockers
_không có_
- **Kết quả payOS thật (2026-11-22 23:29, A):** đường hầm cloudflared → gateway; payOS chấp nhận URL webhook (lần gọi thử `orderCode` 123, chữ ký đúng → `IGNORED`, `200`); `orderCode` 100001 trả 2.000đ thật qua MB → webhook `FT26327657219818` chữ ký đúng, `result = PAID`; `payment_orders` `PAID`, `paid_at` 16:29:01Z (đúng `transactionDateTime` giờ VN); ví 2.000; `payment.deposited` qua RabbitMQ → đơn rental `178b6f9c…` `PAID`, `paid_at` khớp.
