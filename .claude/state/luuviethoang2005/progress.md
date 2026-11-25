---
task: T3.5 Vòng đời đơn: bàn giao, nhận phòng, tự giải ngân
updated: 2026-11-25
percent: 95
---

## Đang làm
- Đủ DoD; push, mở PR

## Đã xong (phiên này)
- T3.4b merge (PR #30), tick (`6645851`)
- Kế hoạch T3.5, A duyệt B1–B10; `RE.DEPOSIT_LIFECYCLE` v1.2 + CHANGELOG
- Migration `audit_log` + 2 index; entity; 3 biến môi trường
- `deposit-state`, `DepositQueryService`, `DepositLifecycleService`, 3 controller, `createRefund`; handler 3 sự kiện; `AutoReleaseJob`, `DeadlineJob`, job (c)
- rental unit 648, e2e 97, infra 61 (môi trường Claude); lint, format, build, contracts sạch; số truy vấn trong ngưỡng
- Walkthrough rental, `CLAUDE.md §2.5`; code-review 5 chiều; commit cục bộ (không dòng ghi công)
- Máy A: `test:infra` 67/67; migration `DepositLifecycle1736000000000`; kiểm chứng E6 (nhắc 08:36:55Z, `RELEASED` AUTO 08:37:55Z, tin `RENTED`)

## Còn lại
- Push, PR → A merge; sau merge tick `implementation/progress.md` T3.5

## Blockers
_không có_
