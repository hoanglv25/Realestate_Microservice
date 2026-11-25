---
task: T3.4b Hết hạn giữ chỗ
updated: 2026-11-25
percent: 85
---

## Đang làm
- Chờ A kiểm chứng compose (E4, E5) và chạy `test:infra` đủ trên máy A; sau đó push, mở PR

## Đã xong (phiên này)
- T3.3 merge (PR #29), tick `implementation/progress.md` (`e21409a`)
- Kế hoạch T3.4b, A duyệt B1–B7; `RE.DEPOSIT_SAGA` v1.4 + CHANGELOG
- `HOLD_EXPIRY_INTERVAL_MS`; `IntervalJob`; `SagaReconcileJob` kế thừa; `HoldExpiryJob`; đăng ký module
- rental unit 196, e2e 97, infra 40 (rental 18, saga-compensation 14, messaging 8); lint, format, build, contracts sạch; 5 truy vấn/lượt 1 đơn
- Walkthrough rental, `CLAUDE.md §2.5`; code-review 5 chiều (không CRITICAL/MAJOR); commit cục bộ

## Còn lại
- Kiểm chứng E4/E5 (máy A, `HOLD_TTL_SECONDS=60`), `pnpm --filter @realestate/rental test:infra` đủ 46
- Push, PR → A merge; sau merge tick `implementation/progress.md` T3.4b

## Blockers
_không có_
