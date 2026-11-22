---
task: T3.3 Saga: bù trừ, đối soát, đồng bộ listing
updated: 2026-11-22
percent: 100
---

## Đang làm
- Đủ DoD (test:infra 40/40 trên máy A, kiểm chứng compose); chờ commit + PR

## Đã xong (phiên này)
- C20 chốt; kế hoạch T3.3 A duyệt (B1–B7)
- `ListingSyncService`, `CompensationService`, `SagaReconcileJob`, `saga-log.ts`; saga nối bù trừ
- `@nestjs/schedule@6.1.3`; `SAGA_RECONCILE_INTERVAL_MS`, `SAGA_STUCK_AFTER_SECONDS`
- rental unit 177, e2e 97, infra 34 (rental 18, saga-compensation 8, messaging 8); lint, format, build, contracts sạch; chạy thật job
- `RE.DEPOSIT_SAGA` v1.3, walkthrough rental, `CLAUDE.md §2.5`

## Còn lại
- Commit, push, PR; sau merge tick `implementation/progress.md` T3.3

## Blockers
_không có_
- **Kiểm chứng compose (2026-11-23 00:10, A):** (1) đơn `PAID` lúc 23:29 → job (b) đẩy → tin `58fe028e…` `DEPOSITED` (hết lỗi tin còn `HELD`). (2) `docker stop re-payment` → đặt cọc → `504 UNKNOWN` sau 9,35 giây (không phải `503` như PHASE-3 dự đoán: DNS Docker trả `ENOTFOUND` sau 3.936 ms > timeout 3.000 ms, ghi C24) → đơn `PENDING_PAYMENT`; bật lại payment → job (a): `404` → đơn `CANCELLED`, `PAYMENT_ORDER_NOT_FOUND`, đã đẩy; tin `c3e2ea29…` `AVAILABLE` (E8). Nhánh `NOT_EXECUTED` → `503` ngay được kiểm ở infra-spec bằng cổng đóng (`ECONNREFUSED`).
