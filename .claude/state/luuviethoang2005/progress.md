---
task: T1.5 Gỡ Mailpit, email identity qua SMTP thật
updated: 2026-11-28 11:20
percent: 75
---

## Đang làm
- Bước 5 (kiểm chứng): còn gửi OTP thật qua Gmail (chờ A điền `SMTP_*` vào `.env`); walkthrough, code-review.

## Đã xong (phiên này)
- Đóng sổ T3.6 (`0bc649d`); nhánh `feature/T1.5-remove-mailpit` từ `develop` `9afb803`.
- Kế hoạch + Reuse Report, A duyệt (Q1 transport giả, Q2 đồng ý, Q3 587, Q4 sửa `business-spec/`).
- Bước 3 tài liệu: C27 + mục D, `PHASE-1.md` T1.5, `progress.md` dòng T1.5, `business-spec/RE.SRS.md`, `RE.BUSINESS_RULES.md`; `RE.IDENTITY` v2.5 + `CHANGELOG.md`.
- TDD `SMTP_PORT` 587: RED (`env.validation.spec.ts` 1 fail: nhận 1025) → GREEN (12/12 PASS, máy A). Comment `mail.service.ts`, `env.validation.ts` bỏ Mailpit.

- `test/helpers/mail-capture.ts` thay `mailpit.ts`; `identity-infra.ts` override `MAIL_TRANSPORT`; otp/password-reset spec, `setup-infra-env.ts`. identity test 357, e2e 97, infra 201 PASS (không Mailpit); độ nhạy 13/23 đỏ khi bỏ thư.
- Compose gỡ `mailpit`, identity lấy SMTP từ `.env`; `.env.example` gốc + identity; README, architecture, glossary, Docker guide, defense guide, implementation README; `infra:up` không còn `re-mailpit`. lint (bỏ `.claude/logs`), format, build, contracts xanh.

## Còn lại
- OTP thật qua Gmail (A điền `.env`); walkthrough identity + CLAUDE.md §2.5; code-review; commit, PR

## Blockers
_không có_
