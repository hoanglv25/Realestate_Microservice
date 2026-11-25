# Tiến độ

> Cập nhật sau mỗi lần merge. Điền ngày hoàn thành thật.

| | |
|---|---|
| **Chủ sở hữu / Cập nhật** | hoang.lv — 2026-11-22 |

**Bảo vệ:** 2026-12-18 (M5) · **Mốc mới** (dời 2026-11-16): M0 11-20, M1 11-27, M2 12-04, M3 12-09, M4 12-11 (`README.md` — Lịch và mốc) · **Hạn nộp báo cáo:** 2026-12-11 (M4, chốt 2026-11-16) · **Đề tài:** Thiết kế hệ thống cho thuê nhà, căn hộ, chung cư Real-estate theo kiến trúc microservices · **Nhóm:** 5 · **Số thành viên:** 3

| Vai | Họ tên | MSSV |
|---|---|---|
| A | Lưu Việt Hoàng | B23DCCC073 |
| B | Đỗ Trung Thành | B23DCCC149 |
| C | Đỗ Trung Thông | B23DCCC153 |

## Đã có trước kế hoạch này

- [x] Monorepo pnpm, ESLint, Prettier, `.nvmrc`
- [x] Hạ tầng Docker Compose (Postgres + PostGIS, Redis, RabbitMQ, Silo, ELK profile demo), `infra:check`
- [x] Topology RabbitMQ phiên bản đầu (`definitions.json`)
- [x] `contracts/` phiên bản đầu (luồng reservation cũ)
- [x] `services/_template-nest` kèm test
- [x] `services/identity`: đăng ký, đăng nhập, làm mới, đăng xuất, `/me`, seed ADMIN

## Phase 0 — Chốt thiết kế

- [x] T0.1 Duyệt nghiệp vụ và mục A của `van-de-can-quyet-dinh.md` — cả nhóm (2026-11-12)
- [x] T0.2 Duyệt kiến trúc và ADR — A, B, C đọc phần của mình (2026-11-16)
- [x] T0.3 Hợp đồng API nội bộ v2 — B (listing), C (rental, payment), A (identity) (2026-11-16)
- [x] T0.4 Hợp đồng sự kiện v2 và topology — A, C (2026-11-16)

## Phase 1 — Nền tảng, gateway

- [x] T1.1 CI: lint, format, contracts, build, test — A (2026-11-18, PR T1.1; bảo vệ nhánh `develop`, `main`)
- [x] T1.2 api-gateway — A (2026-11-17, PR #7)
- [x] T1.3 Compose profile `apps`, identity sau gateway — A (2026-11-18, `d3a2062`)

## Phase 2 — identity, listing

- [x] T2.1 identity: tài khoản nhận tiền, API nội bộ — A (2026-11-19, PR #16, `b88817a`; đổi vai trò bỏ 2026-11-18)
- [x] T2.2 listing: khung, CRUD sản phẩm, duyệt, ảnh — A (2026-11-20, PR #19, `e024605`; A tự giao lại từ B)
- [x] T2.3 listing: tìm kiếm PostGIS, API nội bộ giữ chỗ — A (2026-11-20, PR #21, `0cbd2ea`; A tự giao lại từ B)
- [x] T2.4 listing: seed dữ liệu — A (2026-11-20, PR #23, `db0cfc4`; A tự giao lại từ B)
- [x] T2.5 identity: OTP, quên mật khẩu, Google, khóa tài khoản, số điện thoại — A (2026-11-21, PR #25, `02752d6`)

## Phase 3 — rental, payment

- [x] T3.1 payment: khung, payment order, payOS — A (2026-11-21, PR #26, `e231b32`; A tự giao lại từ C)
- [x] T3.2 rental: khung, lịch xem, saga luồng thành công — A (2026-11-22, PR #27, `8021431`; kiểm chứng payOS thật chuyển sang T3.4a)
- [x] T3.3 Saga: bù trừ, đối soát, đồng bộ listing — A (2026-11-23, PR #29, `207abc1`; giao lại từ C theo chốt 2026-11-18)
- [x] T3.4a Webhook payOS, ghi nhận đặt cọc, tiền đến muộn — A (2026-11-22, PR #28, `6d03f6c`; gồm kiểm chứng payOS thật chuyển từ T3.2)
- [x] T3.4b Hết hạn giữ chỗ — A (2026-11-25, PR #30, `ef2abb5`; tách 2026-11-22)
- [x] T3.5 Vòng đời đơn: bàn giao, nhận phòng, tự giải ngân — A (2026-11-25, PR #31, `549977a`; giao lại từ B theo chốt 2026-11-18)
- [ ] T3.6 Payout: hoàn, rút, chứng từ, ví — C

## Phase 4 — Bất đồng bộ, notification, chat

- [ ] T4.1 Binding queue, schema sự kiện trong code — C (chuyển từ A 2026-11-16)
- [ ] T4.2 notification: consumer, API thông báo — A
- [ ] T4.3 Thử lại, DLQ, kiểm chứng — A
- [ ] T4.4 Chat và WebSocket — A

## Phase 5 — Hợp đồng và kiểm thử

- [ ] T5.1 OpenAPI mỗi service — mỗi người phần mình, A tổng hợp
- [ ] T5.2 Postman collection — B, mỗi người thư mục của mình
- [ ] T5.3 CI e2e với Newman — B
- [ ] T5.4 Kiểm tra trên máy sạch — B, chạy trên máy C (chuyển từ A 2026-11-16)

## Phase 6 — Thí nghiệm lỗi

- [ ] T6.1 Hạ tầng đo, k6, ảnh chụp dữ liệu — B
- [ ] T6.2 E1, E2, E3 (bắt buộc) — B
- [ ] T6.3 E4–E10 — C, B

## Phase 7 — Nộp bài

- [ ] T7.1 Báo cáo cuối kỳ — A tổng hợp, mỗi người chương của mình
- [ ] T7.2 Slide — A
- [ ] T7.3 Tập demo, video dự phòng, vấn đáp — cả nhóm
- [ ] T7.4 Rà soát cuối — A

## Ghi chú và vướng mắc

| Ngày | Người | Nội dung | Cách xử lý |
|---|---|---|---|
| 2026-11-16 | A | T0.3, T0.4 nhóm duyệt chéo xong. `pnpm contracts:check`: 18 event, 4 spec (identity, listing, payment, rental internal), tất cả OK. Đã xóa 7 schema luồng cũ; sự kiện lịch xem sửa theo quyết định 2026-11-16 | Tick |
| 2026-11-16 | A | M0 (2026-11-13) trễ: T0.2, T1.1–T1.3 chưa xong | Ưu tiên T1.2 gateway (A), T1.1 CI (B) trước Phase 2 |
| 2026-11-16 | A | T0.2: Accept 12 ADR; thiết kế v1.0 thành baseline (sửa `design/` từ nay kèm `CHANGELOG.md`). Chốt C7, C17, C18, B16, chi tiết T2.1 (`van-de-can-quyet-dinh.md` mục D). T1.2 hết chặn | Tick T0.2; B, C vẫn đọc ADR phần mình |
| 2026-11-16 | A | Chốt đợt 2: C1, C2, C3–C6, C8, C10, C11, C13, C14, C15, C16 và mọi `[cần xác nhận]` còn lại của thiết kế (trừ `PAYMENT_CALL_TIMEOUT_MS` chờ đo). 11 thiết kế lên v1.1 kèm `CHANGELOG.md`. Báo cáo nộp M4 | B, C xem lại phần mình khi nhận task |
| 2026-11-16 | A | Ước thời lượng: ~240 giờ còn lại, vượt năng lực 12,75 giờ/người/tuần. Dời M0–M3, chia lại T3.5 → B, T4.1 → C, T5.4 → B; kế hoạch tính 16 giờ hiệu dụng/người/tuần | B, C xác nhận mức giờ; không được thì cắt theo `README.md §6` |
| 2026-11-17 | A | T1.2 merge vào `develop` (PR #7, `d4dcb14`): gateway unit 226 + e2e 134 PASS, đủ test 1–12; template và identity vá C14, C18, `JwtTokenVerifier`; `test:infra` template + identity user tự chạy. Việc chuyển sang T1.3 ghi ở `.claude/state/luuviethoang2005/current-task.md` mục "Chuyển sang T1.3" | Tick T1.2; làm T1.3 (hạn 11-20) |
| 2026-11-18 | A | T1.3 merge vào `develop` (`d3a2062`): identity, api-gateway chạy trong profile `apps`; đăng ký, đăng nhập, `/me` qua 8080; cùng `X-Request-ID` ở hai log; `/internal/*` 404 | Tick T1.3; làm T1.1 (A), rồi tag `v0.1-skeleton` |
| 2026-11-18 | A | T1.1 merge vào `develop`: CI `check` → `test` (template-nest, identity, api-gateway) → `ci` xanh; PR thử schema hỏng (#13) đỏ đúng ở `contracts:check` rồi đóng. Repo chuyển public để bảo vệ nhánh có hiệu lực (GitHub Free); `develop`, `main` bắt buộc PR + `ci` xanh, không bypass. Phase 1 xong | Tick T1.1; tag `v0.1-skeleton`; sang T2.1 |
| 2026-11-19 | A | T2.1 merge vào `develop` (PR #16, `b88817a`), CI `check`, `test` (template-nest, identity, api-gateway), `ci` xanh. identity unit 201, e2e 97, infra 99 PASS. Có: `bank_accounts` mã hóa AES-256-GCM (AAD `userId`), route 6–8, `GET /internal/users/:id/bank-account` khớp `identity-internal.v1.yaml`, `revokeAllForUser`, `BANK_ACCOUNT_ENCRYPTION_KEY` bắt buộc; template thêm `PageQueryDto`, `createUuidParamPipe`, `expectResponseMatchesOpenApi`. Repo chuyển sang `hoanglv25/Realestate_Microservice`. A chốt C19 phương án (b) | Tick T2.1; sửa template theo C19 trước T2.2 rồi làm T2.2 |
| 2026-11-20 | A | T2.2 merge vào `develop` (PR #19, `e024605`), CI `check`, `test` (template-nest, identity, api-gateway, listing), `ci` xanh; listing lần đầu vào ma trận CI. listing unit 233, e2e 97, infra 52 PASS; số truy vấn mỗi route 2–5 (ngưỡng 6). Có: `services/listing` (cổng 3002, `listing_db` PostGIS, bucket `listing-images`) trong profile `apps`, route 1–10, 12, `/mine`; template thêm `StorageService.headObject` (chép sang identity). `RE.LISTING` v1.2, `RE.SERVICE_TEMPLATE` v2.1. Nợ: tech-debt #14 (ảnh mồ côi trên S3), #15 (bảng outbox không dùng) | Tick T2.2; A chốt `RE.LISTING` §8 cùng ngày (v1.3, đúng như code); sang T2.3 |
| 2026-11-20 | A | T2.3 merge vào `develop` (PR #21, `0cbd2ea`), CI `check`, `test` (template-nest, identity, api-gateway, listing), `ci` xanh. listing unit 356, e2e 97, infra 109 PASS; 50 lời giữ chỗ đồng thời đúng một `200` (thử đột biến bỏ `held_until < now()` thì test fail). Có: route 11 tìm kiếm `ST_DWithin` (`EXPLAIN` 5.000 tin dùng `ix_listings_location`), `/internal/listings/:id`, `/holds`, `/status` khớp `listing-internal.v1.yaml`; 3 index tìm kiếm (GIN `amenities`, `created_at`, `area_m2`). Số truy vấn: tìm kiếm 2, bản chụp 1, giữ chỗ 1–2, đổi trạng thái 1–2. `RE.LISTING` v1.4, `RE.DEPOSIT_SAGA` v1.2 | Tick T2.3; C20 (rental xử lý `409` khi đích `AVAILABLE`) chốt ở T3.x; sang T2.4 (DoD có chạy lại `EXPLAIN` trên seed thật) |
| 2026-11-22 | A | T3.2 merge vào `develop` (PR #27, `8021431`), CI có thêm `test (rental)`. rental unit 158, e2e 97, infra 18 + messaging 8 PASS. payOS không có môi trường thử riêng (giao dịch thật, số tiền nhỏ) và payment chưa có route webhook, nên mục kiểm chứng payOS thật chuyển sang T3.4a; tách T3.4 → T3.4a (webhook), T3.4b (hết hạn giữ chỗ). Chặng A đã chạy: đặt cọc qua gateway tạo được link payOS thật (`orderCode` 100000, 2.000đ, chưa thanh toán) | Tick T3.2; làm T3.4a |
| 2026-11-22 | A | T3.4a kiểm chứng **payOS thật**: cloudflared → gateway 8080; payOS chấp nhận URL webhook; `orderCode` 100001 chuyển 2.000đ thật → webhook chữ ký đúng, `PAID`; order `PAID`, ví 2.000; `payment.deposited` qua RabbitMQ → đơn rental `PAID` (`paid_at` khớp `transactionDateTime`). Đây cũng là mục DoD payOS thật chuyển từ T3.2. payment `test:infra` 49/49 trên máy A | Commit, PR T3.4a; sau merge tick T3.4a; tiếp T3.3 (chốt C20) |
| 2026-11-22 | A | T3.4a merge vào `develop` (PR #28, `6d03f6c`). Luồng đặt cọc thành công chạy với tiền thật: rental → payment → payOS → webhook → `payment.deposited` → đơn `PAID`. Mốc M1 (2026-11-27, "saga luồng thành công chạy được") đạt sớm 5 ngày. Còn: tin ở listing giữ `HELD` sau `PAID` (đẩy `DEPOSITED` là T3.3, chờ C20) | Tick T3.4a; tiếp T3.3 hoặc T3.4b |
| 2026-11-23 | A | T3.3 kiểm chứng compose: đơn `PAID` → tin `DEPOSITED` (job (b)); dừng payment → đặt cọc `504` (DNS Docker chậm 3,9 giây > timeout, **C24** chờ A) → bật lại → job (a) bù trừ, tin `AVAILABLE` (E8). C20 chốt, áp ở `ListingSyncService` | Merge T3.3; quyết C24 khi chốt A2 (E1, E2) |
| 2026-11-23 | A | T3.3 merge vào `develop` (PR #29, `207abc1`), CI `check`, `test` (template-nest, identity, api-gateway, listing, payment, rental), `ci` xanh. rental unit 177, e2e 97, `test:infra` 40/40 PASS. Có: bù trừ (`CompensationService`), đồng bộ listing (`ListingSyncService`; C20: 4xx từ listing là kết cục cuối), `SagaReconcileJob` (`@nestjs/schedule` 6.1.3, 12.x là ESM thuần). Số truy vấn `POST /deposits`: thành công 5, bù trừ 7 (A chấp nhận). `RE.DEPOSIT_SAGA` v1.3. Còn mở: C24 (payment dừng → `504` thay vì `503`) | Tick T3.3; tiếp T3.4b (`HoldExpiryJob`), rồi T3.5 |
| 2026-11-25 | A | T3.4b kiểm chứng compose: `HOLD_TTL_SECONDS=60`, đặt cọc tin 20 không trả → `HoldExpiryJob` hủy order payOS (`100002` `CANCELLED`) rồi đơn `EXPIRED` sau ~65 giây (4,9 giây sau hạn), tin `AVAILABLE` (E4); webhook giả vào link đã hủy → `late_payments` + yêu cầu hoàn (E5). rental unit 196, e2e 97, `test:infra` 46/46 (máy A). `RE.DEPOSIT_SAGA` v1.4; khung job `IntervalJob` | PR T3.4b; sau merge tick T3.4b; tiếp T3.5 |
| 2026-11-25 | A | T3.4b merge vào `develop` (PR #30, `ef2abb5`), CI `check`, `test` (template-nest, identity, api-gateway, listing, payment, rental), `ci` xanh. Có: `HoldExpiryJob` (BR-09: hủy link trước, nhả chỗ sau), khung `IntervalJob` (`SagaReconcileJob` kế thừa), `HOLD_EXPIRY_INTERVAL_MS`. 6 commit của PR còn dòng ghi công AI (trái `git-workflow.md` dòng 39); merge rồi nên giữ nguyên, không viết lại `develop` | Tick T3.4b; tiếp T3.5 |
| 2026-11-25 | A | T3.5 kiểm chứng compose: `AUTO_RELEASE_SECONDS=120`, `RELEASE_REMINDER_SECONDS=60`; đặt cọc tin 22 + webhook giả (`orderCode` 100003) → `PAID` 08:35:50Z → `rental.release-reminder` 08:36:55Z → `RELEASED` trigger `AUTO` 08:37:55Z (5 giây sau mốc), tin `RENTED` (E6). rental unit 648, e2e 97, `test:infra` 67/67 (máy A); E7 kiểm bằng chạy đồng thời + 2 khe đua cố định. Nhánh hoàn/rút chạy đầu-cuối chờ T3.6 (payment chưa có `refund-requests`, chưa phát `refunded`…). `RE.DEPOSIT_LIFECYCLE` v1.2 | PR T3.5; sau merge tick T3.5; tiếp T3.6 |
| 2026-11-25 | A | T3.5 merge vào `develop` (PR #31, `549977a`). Có: máy trạng thái đơn, route 1–7, `withdrawal-eligibility`, `AutoReleaseJob`, `DeadlineJob`, `SagaReconcileJob` (c), handler `refunded`/`refund-rejected`/`withdrawal-completed`, `audit_log`. Migration `1736000000000` cần chạy với `DATABASE_URL` của rental (`services/rental/.env` chưa có) | Tick T3.5; tiếp T3.6 |
