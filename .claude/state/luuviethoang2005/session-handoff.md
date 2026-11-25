---
dev: luuviethoang2005
saved: 2026-11-23 00:21
task: T3.3 Saga: bù trừ, đối soát, đồng bộ listing
status: in_progress
percent: 100
---

> Snapshot phiên gần nhất. Ghi đè mỗi lần `/cf-handoff`; đọc lại bằng `/cf-resume`.

## Đang làm dở
- Task: T3.3 Saga: bù trừ, đối soát, đồng bộ listing (`implementation/PHASE-3.md#T3.3`)
- Bước hiện tại: bước 8 xong về nội dung (kiểm chứng compose, thiết kế v1.3, walkthrough, code-review, commit). Đủ DoD; chỉ còn mở PR và merge.

## File đang sửa
- Working tree sạch. Nhánh `feature/T3.3-saga-compensation` đã push, khớp `origin` (không còn commit chưa đẩy).
- Commit của task: `9e585aa` (design v1.3), `b67baf2` (code rental), `9a70c23` (env, compose), `40ee6e9` (walkthrough, mục lục), `4e37653` (state).

## Quyết định, context quan trọng
- C20 chốt 2026-11-22: `409 LISTING_INVALID_STATUS` khi đẩy đích `AVAILABLE` là kết cục cuối (`decisions-log.md`).
- `@nestjs/schedule` dùng **6.1.3**, không phải 12.0.3 như A đã duyệt, vì 12.x là ESM thuần và Jest không chạy được trên rental CommonJS (ghi ở `current-task.md`, Blockers/Ghi chú).
- Nhánh bù trừ của `POST /deposits` tốn 7 truy vấn (A chấp nhận B4). Nhánh thành công giữ 5.
- Payment dừng → `504 UNKNOWN` sau ~9,35 giây, không phải `503` như PHASE-3 dự đoán (DNS Docker `ENOTFOUND` sau 3,9 giây > timeout 3 giây, ghi C24). Nhánh `NOT_EXECUTED` → `503` được kiểm ở infra-spec.
- Kết quả test: rental unit 177, e2e 97, `test:infra` 40/40 (máy A, 2026-11-23 00:17). lint, format:check, build, contracts:check sạch.
- Kiểm chứng compose xong (E8: đơn `CANCELLED`, tin `AVAILABLE`; đơn `PAID` → tin `DEPOSITED`).
- Tech-debt #24 (infra-spec viết sau code) ở trạng thái accepted.

## Blockers
- _không có_ (lưu ý: `gh` chưa cài trên máy này, mở PR bằng trình duyệt hoặc cài `gh`; chưa kiểm được PR đã mở chưa)

## Việc tiếp theo
- [ ] Mở PR `feature/T3.3-saga-compensation` → `develop` theo `.github/PULL_REQUEST_TEMPLATE.md` (dán kết quả test, ghi "Lệch thiết kế: đã cập nhật CHANGELOG", "Hợp đồng: không đổi"); A merge
- [ ] Sau merge: tick `implementation/progress.md` T3.3
- [ ] Task tiếp theo: T3.4b (`HoldExpiryJob`, test 11–13), rồi T3.5 (vòng đời đơn)
