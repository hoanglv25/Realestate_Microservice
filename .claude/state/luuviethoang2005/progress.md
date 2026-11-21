---
task: T3.2 rental: khung, lịch xem, saga luồng thành công
updated: 2026-11-21
percent: 95
---

## Đang làm
- Bước hiện tại: xong code, test, tài liệu; commit trên `feature/T3.2-rental-saga`, chờ push và PR (A merge)
- Còn thiếu một mục DoD: kiểm chứng end-to-end với payOS thử nghiệm thật (cần khóa của A và webhook T3.4)

## Đã xong (phiên này)
- `progress.md` tick T2.5, T3.1
- `services/rental`: migration `deposits`, `saga_log`, `viewings`; `ListingLock`, `ListingClient`, `PaymentClient`, `classifyCall`; `DepositSagaService.start`; `ViewingService` + 5 route; `PaymentEventsHandler`
- rental unit 158, e2e 97, infra `rental` 18 + `messaging` 8; lint, format, build, contracts sạch; chạy thật `/health` ok
- Compose `rental`, `.env.example` gốc (bỏ 4 biến luồng cũ, A3), CI matrix, README, walkthrough mới, `CLAUDE.md §2.5`, `project-structure.md`

## Còn lại
- Push, PR vào `develop`, A merge; sau merge tick `implementation/progress.md` T3.2
- T3.3: bù trừ, job đối soát, đồng bộ listing (C20 vẫn mở)

## Blockers
_không có_
