---
task: T1.5 Gỡ Mailpit, email identity qua SMTP thật
created: 2026-11-28
status: in_progress
phase: implementation/PHASE-1.md#T1.5 (task ngoài kế hoạch, A đồng ý 2026-11-28; mục PHASE-1 thêm ở Bước 2)
branch: feature/T1.5-remove-mailpit (từ `develop` tại `9afb803`)
---

## Mô tả

Bỏ container Mailpit khỏi hạ tầng dev. identity gửi OTP, link đặt lại mật khẩu qua SMTP thật (Gmail App Password) cấu hình ở `.env`; `test:infra` của identity không còn phụ thuộc Mailpit. Đảo quyết định 2026-11-12 "Email qua Mailpit — hạ tầng bắt buộc của identity" (`van-de-can-quyet-dinh.md`). Người làm: A cùng Claude.

## Thiết kế liên quan

`design/IDENTITY/RE.IDENTITY/` (API_Spec, Component_Class_Design, Processing_Flow nhắc Mailpit) — sửa tài liệu + `CHANGELOG.md` trước code. Báo cáo v2 (`business-spec/RE.SRS.md`, `RE.BUSINESS_RULES.md`) có nhắc Mailpit → ghi lệch vào `van-de-can-quyet-dinh.md`.

## Đánh giá sơ bộ

- Loại: hạ tầng + test + tài liệu. Service chạm: identity (test hạ tầng, comment/env), `infra/compose`, `.env.example` gốc và identity.
- Migration: không. Hợp đồng `contracts/`: không.
- Phần người khác sở hữu: không (mọi task giao A, chốt 2026-11-18).

## Definition of Done

- [x] Không còn service `mailpit` trong `infra/compose/docker-compose.yml`; identity (profile `apps`) lấy `SMTP_*`, `MAIL_FROM` từ `.env`, không `depends_on: mailpit` (`docker compose config` dev/demo/apps hợp lệ, không còn chữ mailpit; 2026-11-28)
- [x] identity `test`, `test:e2e`, `test:infra` pass không cần Mailpit (2026-11-28, máy A, đã `docker rm -f re-mailpit`): `test` 32 suite / 357 PASS; `test:e2e` 11 / 97 PASS; `test:infra` 14 / 201 PASS. Độ nhạy: transport giả bỏ thư → `otp.infra-spec` 13/23 đỏ, khôi phục
- [x] `RE.IDENTITY` + `CHANGELOG.md`, `van-de-can-quyet-dinh.md`, `PHASE-1.md` (mục T1.5), README, guide, walkthrough identity cập nhật; không còn hướng dẫn trỏ tới Mailpit (2026-11-28; còn nhắc Mailpit chỉ ở lịch sử: `PHASE-2.md` T2.5, mục D 2026-11-12 đã ghi "bị thay bởi C27", CHANGELOG)
- [x] `pnpm lint`, `pnpm format:check`, `pnpm build`, `pnpm contracts:check` không lỗi (2026-11-28: build, contracts xanh; lint xanh khi bỏ `.claude/logs/**` — lỗi duy nhất ở `.claude/logs/upload-test/server.mjs` cục bộ, đã ignore git; format xanh trên file của task, cảnh báo duy nhất ở `listing-service-overview.md` chưa track của A)
- [ ] Kiểm chứng: `pnpm infra:up` không còn `re-mailpit`; đăng ký qua Swagger → OTP về hộp thư thật; `docker compose config` hợp lệ cho profile `dev`, `demo`, `apps`

## Các bước thực hiện (tổng quan)
- [x] 1. Đọc context, đối chiếu thiết kế (2026-11-28)
- [x] 2. Quét tái sử dụng + kế hoạch chi tiết (A duyệt 2026-11-28)
- [x] 3. Sửa tài liệu: quyết định, thiết kế + CHANGELOG, PHASE-1 (2026-11-28)
- [x] 4. Code + test theo playbook đang bật (test hạ tầng thay Mailpit; compose; env) (2026-11-28)
- [ ] 5. Chạy test và lệnh kiểm chứng, xác nhận PASS
- [ ] 6. Walkthrough identity, `code-review` 5 chiều, chuẩn bị PR (walkthrough + review xong 2026-11-28; chờ commit, PR)

## Tái sử dụng
> Quét 2026-11-28 · Nguồn: `services/identity/src`, `services/identity/test/helpers`, `services/_template-nest` (src, test/helpers), `services/*/src` + `test` khác, `package.json` gốc và identity · Cách tra: grep `sendMail|MailTransport|fake.*mail|captur|smtp-server|nodemailer`, đọc `test/helpers/{infra,identity-infra,mailpit}.ts`, `mail.service(.spec).ts`, `identity.module.ts`
> Từ khóa: mail, sendMail, transport, smtp, capture, fake · Vùng mù: không

| Thành phần cần | Nhóm | Vị trí đã có / lý do viết mới |
|---|---|---|
| Chờ có kết quả (hỏi lại) | DÙNG LẠI | `services/identity/test/helpers/infra.ts#waitFor` |
| Thay provider khi dựng app test | DÙNG LẠI | `services/identity/test/helpers/identity-infra.ts#StartOptions.overrides` (truyền vào `createTestApp`) |
| Token DI + kiểu transport | DÙNG LẠI | `services/identity/src/identity/services/mail.service.ts#MAIL_TRANSPORT`, `#MailTransport` |
| Transport giả ghi nhận thư trong bộ nhớ + `waitForMails`/`otpOf`/`resetTokenOf`/`expectNoMail` | MỞ RỘNG | Thay `services/identity/test/helpers/mailpit.ts` (đọc API Mailpit) bằng `test/helpers/mail-capture.ts` giữ nguyên tên hàm, nguồn thư là bộ nhớ thay vì HTTP Mailpit. Chỉ là helper test của identity, không phải phần kỹ thuật chung của template (template không gửi mail) |
| Thư viện SMTP giả (`smtp-server`) | — | Không dùng (chưa có trong `architecture.md §5`; chỉ cần nếu chọn phương án B ở kế hoạch) |

## Kế hoạch chi tiết

> Trình A 2026-11-28. **A duyệt 2026-11-28: Q1 = A (transport giả), Q2 = đồng ý, Q3 = 587, Q4 = sửa luôn 2 dòng `business-spec/` (không cần mục B).** Playbook bật: `tdd` (warn) — thay đổi hành vi duy nhất ở `src` là mặc định `SMTP_PORT`: sửa test trước (RED) rồi code (GREEN). Phần test hạ tầng: đổi nguồn thư, chạy lại để thấy xanh. Không endpoint, truy vấn DB, migration, `contracts/` nào bị chạm (số truy vấn không đổi).

**Quyết định cần A chốt (Q1–Q4):**
- Q1 Thay Mailpit trong `test:infra`: **A (đề xuất)** transport giả trong bộ nhớ, `startIdentityInfra` mặc định override `MAIL_TRANSPORT`, giữ nguyên các assert (from, subject, OTP, token, đúng số thư, không có thư); không thêm thư viện; mất phần kiểm giao thức SMTP thật (vốn chỉ là `createTransport` của nodemailer). B: thêm devDependency `smtp-server`, dựng SMTP giả trong tiến trình test ở cổng ngẫu nhiên (giữ đường SMTP thật, thêm thư viện cần duyệt). C: bỏ assert email (không đề xuất).
- Q2 identity trong Docker (profile `apps`): `SMTP_HOST`, `SMTP_PORT` (mặc định 465), `SMTP_USER`, `SMTP_PASSWORD`, `MAIL_FROM` lấy từ `.env` gốc bằng `${X:-}` (không `:?` để `infra:up` của người chưa có SMTP không hỏng); thiếu `SMTP_HOST`/`MAIL_FROM` thì identity tự báo thiếu và dừng như hiện nay. Hệ quả: ai chạy identity (host hay Docker) đều cần thông tin SMTP (Gmail chung của nhóm, chia sẻ qua kênh riêng).
- Q3 Mặc định `SMTP_PORT` trong `env.validation.ts`: 1025 (cổng Mailpit) → **587** (đề xuất; STARTTLS chuẩn). Hoặc giữ 1025.
- Q4 Báo cáo v2 (`business-spec/RE.SRS.md` dòng 111, `RE.BUSINESS_RULES.md` dòng 163 ghi "Mailpit khi dev"): **ghi mục B (lệch) trong `van-de-can-quyet-dinh.md`, không sửa `business-spec/`** (đề xuất; A cập nhật báo cáo Word rồi đồng bộ sau). Hoặc sửa luôn hai dòng.

**Các bước con (theo thứ tự):**
1. Tài liệu quyết định: `implementation/van-de-can-quyet-dinh.md` thêm C27 (đã chốt, gạch) + dòng mục D 2026-11-28 đảo quyết định 2026-11-12 "Email qua Mailpit"; (Q4) sửa `business-spec/RE.SRS.md` dòng 111, `RE.BUSINESS_RULES.md` dòng 163. `implementation/PHASE-1.md` thêm mục T1.5 (khuôn T1.4: Đọc trước, các bước, Kiểm chứng, DoD). `implementation/progress.md` thêm dòng `- [ ] T1.5`.
2. Thiết kế trước code: `design/IDENTITY/RE.IDENTITY/` v2.5 PATCH — `API_Spec.md` dòng 8 và §5 (dòng 230: mặc định dev), `Processing_Flow.md` participant "SMTP (Mailpit)" → "SMTP", `Component_Class_Design.md` test 13 "Mailpit nhận" → "transport ghi nhận"; `CHANGELOG.md` mục [v2.5].
3. TDD `SMTP_PORT` (nếu Q3 = 587): sửa `src/config/env.validation.spec.ts` (mặc định 587) → chạy, thấy FAIL → sửa `src/config/env.validation.ts` (default 587, comment) → PASS. Không chép sang `_template-nest`: `services/_template-nest/src/config/env.validation.ts` không có biến SMTP (đã grep 2026-11-28).
4. Test hạ tầng: tạo `test/helpers/mail-capture.ts`, xóa `test/helpers/mailpit.ts`; `test/helpers/identity-infra.ts` mặc định override `MAIL_TRANSPORT` bằng transport giả (cho phép `overrides` của từng test ghi đè), xóa thư cũ khi `close()`; `otp.infra-spec.ts`, `password-reset.infra-spec.ts` đổi import; `setup-infra-env.ts` bỏ `MAILPIT_SMTP_PORT`, SMTP trỏ `localhost:1025` không có máy chủ (spec không dùng `startIdentityInfra` chỉ ghi log `warn`, như khi chưa bật Mailpit). (Q1 = B thì thay bằng `smtp-server`.)
5. Comment trong `src/identity/services/mail.service.ts` (dòng 35) và `env.validation.ts` (dòng 50): bỏ "Mailpit".
6. Hạ tầng: `infra/compose/docker-compose.yml` xóa service `mailpit`, comment profile `dev` (dòng 9), `depends_on: mailpit` của identity; env identity theo Q2. `.env.example` gốc: bỏ `MAILPIT_*`, mẫu Gmail (`smtp.gmail.com`, 465, `SMTP_USER`, `SMTP_PASSWORD` trống, `MAIL_FROM` trống + hướng dẫn App Password). `services/identity/.env.example` tương tự. Kiểm `docker compose config` cho `dev`, `demo`, `apps`.
7. Tài liệu: `README.md` gốc (dòng 81), `services/identity/README.md` (dòng 26–27, 167, 181), `architecture.md` dòng 89, `domain-glossary.md` dòng 17, `guides/RE_Docker_Local_Guide.md` (24, 35, 76, 170), `guides/RE_Report_Defense_Guide.md` dòng 55, `implementation/README.md` dòng 137 (X3: "email thông báo qua SMTP"). Giữ nguyên `PHASE-2.md` T2.5 (lịch sử việc đã làm).
8. Kiểm chứng (Bước 4 developer): `pnpm --filter @realestate/identity test`, `test:e2e`, `test:infra` (không chạy container Mailpit: `docker rm -f re-mailpit` trước); `pnpm lint; pnpm format:check; pnpm build; pnpm contracts:check`; `pnpm infra:up` không có `re-mailpit`; identity `pnpm dev` với Gmail của A → đăng ký qua Swagger, OTP về hộp thư thật.
9. `guides/RE_Identity_Code_Walkthrough.md` cập nhật (dòng 18, 50, 92, 156–157, 193; thêm file `mail-capture.ts`), `project-knowledge/CLAUDE.md §2.5` dòng 197; `code-review` 5 chiều; commit theo Conventional Commits, không dòng ghi công; PR vào `develop`.

**Không làm trong task:** sửa `.env` thật của A (A tự điền App Password; Claude chỉ nhắc), `scripts/run-identity-dev.cmd` (file local chưa commit; Claude bỏ bước chờ `re-mailpit` riêng, không đưa vào PR trừ khi A muốn).

## Blockers / Ghi chú
- Shell của Claude (VM) không có `git config user.email`; commit dùng `-c user.name="hoanq" -c user.email="luuviethoang2005@gmail.com"` giống các commit trước.

## Code review 5 chiều (2026-11-28)

- **Security:** không secret nào vào repo (`.env.example` để trống `SMTP_USER`, `SMTP_PASSWORD`, `MAIL_FROM`); compose truyền `SMTP_PASSWORD` từ `.env` như các mật khẩu khác; log của `MailService` không đổi (không OTP, link, địa chỉ). Không vấn đề.
- **Performance:** không chạm endpoint, truy vấn; số truy vấn test 13–19 giữ nguyên (đếm trong `otp`/`password-reset.infra-spec` vẫn xanh). Không vấn đề.
- **Correctness:** `SMTP_PORT` 587 + nodemailer `secure: port === 465` → 587 STARTTLS, 465 TLS; `SMTP_USER` rỗng → `optionalString` → không `auth`. Override `MAIL_TRANSPORT` đặt trước `options.overrides` nên test vẫn ghi đè được. Độ nhạy đã kiểm (13/23 đỏ khi bỏ thư). MINOR: `setup-infra-env.ts` vẫn trỏ `localhost:1025` cho spec tự dựng app — nếu máy còn container Mailpit cũ thì thư của các spec đó vào đó; vô hại.
- **Style:** helper đặt ở `test/helpers/` cạnh `identity-infra.ts`, tên theo vai trò; comment compose không dấu như phần còn lại của file. Không vấn đề.
- **Reuse:** có Reuse Report; dùng lại `waitFor`, `StartOptions.overrides`, `MAIL_TRANSPORT`; `mailpit.ts` bị thay, không có bản song song; không import chéo service.
- Kết luận: không CRITICAL/MAJOR.
