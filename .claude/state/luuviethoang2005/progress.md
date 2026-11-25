---
task: T3.4b Hết hạn giữ chỗ
updated: 2026-11-25
percent: 95
---

## Đang làm
- Đủ DoD; push, mở PR

## Đã xong (phiên này)
- T3.3 merge (PR #29), tick `implementation/progress.md` (`e21409a`)
- Kế hoạch T3.4b, A duyệt B1–B7; `RE.DEPOSIT_SAGA` v1.4 + CHANGELOG
- `HOLD_EXPIRY_INTERVAL_MS`; `IntervalJob`; `SagaReconcileJob` kế thừa; `HoldExpiryJob`; đăng ký module
- rental unit 196, e2e 97, infra 40 (rental 18, saga-compensation 14, messaging 8); lint, format, build, contracts sạch; 5 truy vấn/lượt 1 đơn
- Walkthrough rental, `CLAUDE.md §2.5`; code-review 5 chiều (không CRITICAL/MAJOR); commit cục bộ
- Máy A: `test:infra` 46/46; kiểm chứng compose E4 (`EXPIRED` ~65 giây, tin `AVAILABLE`), E5 (`late_payments` + yêu cầu hoàn)

## Còn lại
- Push, PR → A merge; sau merge tick `implementation/progress.md` T3.4b

## Blockers
_không có_
