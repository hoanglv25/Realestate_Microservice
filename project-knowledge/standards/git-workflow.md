# Quy trình Git

> Lịch sử commit là bằng chứng ai làm gì. Nguồn: README gốc mục "Quy ước nhánh và commit", `.github/PULL_REQUEST_TEMPLATE.md`, `.github/CODEOWNERS`.

| | |
|---|---|
| **Chủ sở hữu / Cập nhật** | hoang.lv — 2026-11-18 |

## 1. Nhánh

| Nhánh | Vai trò |
|---|---|
| `main` | Bản ổn định, được bảo vệ |
| `develop` | Nhánh tích hợp, được bảo vệ, mọi PR vào đây |
| `feature/<task>-<mô-tả>` | Một task, ví dụ `feature/T3.2-deposit-saga` |
| `fix/<mô-tả>` | Sửa lỗi |

Luồng: `main` ← `develop` ← `feature/*`.

```powershell
git checkout develop; git pull origin develop
git checkout -b feature/T3.2-deposit-saga
```

## 2. Commit

Conventional Commits, phạm vi là service hoặc thư mục:

```
feat(rental): thêm bước giữ chỗ vào saga đặt cọc (T3.2)
fix(payment): bỏ qua webhook trùng mã giao dịch
chore(infra): thêm queue rental.payment-events
docs(design): chốt đường dẫn API listing
```

- Một commit một ý. Chỉ `git add` file liên quan.
- Ghi mã task trong ngoặc ở cuối dòng tiêu đề.
- Không commit: `.env`, `secrets/`, `node_modules`, `dist`, code chưa build được.
- Không thêm dòng ghi công AI vào commit hay mô tả PR: không `Co-Authored-By: Claude …`, không `Claude-Session: …`, không "Generated with Claude Code" (A chốt 2026-11-22). Cấu hình ở `.claude/settings.json` (`attribution.commit`, `attribution.pr` để trống). Commit cũ giữ nguyên, không viết lại lịch sử.

## 3. Pull request

Mỗi task một PR, vào `develop`, theo `.github/PULL_REQUEST_TEMPLATE.md`. Mô tả gồm:

```markdown
## Task
T3.2 — link tới mục trong implementation/PHASE-3.md

## Thay đổi
-

## Đã kiểm chứng
- [ ] pnpm --filter @realestate/<service> test: dán kết quả
- [ ] Lệnh kiểm chứng trong task: dán kết quả

## Lệch thiết kế
Không / hoặc: đã cập nhật CHANGELOG của design/...

## Hợp đồng
Không đổi / hoặc: đã sửa contracts/... và người phụ trách bên gọi đã duyệt
```

**Điều kiện merge:** CI xanh (check `ci`, `.github/workflows/ci.yml`), đủ DoD của task. Không bắt buộc người duyệt: A viết hầu hết PR và GitHub không cho tự duyệt PR của mình (chốt 2026-11-18). Bảng dưới là người nên nhờ review khi cần.

| PR chạm | Người duyệt |
|---|---|
| `contracts/openapi/<service>-internal.v1.yaml` | Người phụ trách service **gọi** |
| `contracts/events/` | Người phụ trách mọi service nghe sự kiện đó |
| `services/_template-nest/`, `infra/` | A |
| Còn lại | Một người khác trong nhóm (`.github/CODEOWNERS`) |

## 4. Khi có xung đột

```powershell
git fetch origin
git rebase origin/develop
# sửa conflict
git push --force-with-lease
```

Chỉ force push nhánh của mình. Không force push `main`, `develop`.

## 5. Mốc

Tag đánh dấu mốc trong lịch (`implementation/README.md` — Lịch và mốc).

| Tag | Mốc | Ý nghĩa |
|---|---|---|
| `v0.1-skeleton` | M0 — 2026-11-13 | Xong Phase 1: gateway + identity chạy sau gateway |
| `v0.5-deposit-flow` | M2 — 2026-11-27 | Xong Phase 3: luồng đặt cọc, hoàn, rút chạy được |
| `v1.0-submission` | M5 — 2026-12-18 | Bản nộp, bảo vệ |

## 6. Không nên

- Một người commit thay người khác.
- Commit dồn trong ngày cuối.
- Sửa trực tiếp trên `main`, `develop`.
- Đổi hợp đồng `contracts/` mà không báo bên gọi.
