# Cấu trúc file toàn bộ dự án

> Cấu trúc đích của repo `Realestate_Microservice`: gateway và 5 service. Tổng hợp từ `Component_Class_Design.md` của từng chức năng. Khi hai bên khác nhau, thiết kế của chức năng đó quyết định.
>
> Ký hiệu: `✓` đã có trong repo; `+` theo kế hoạch. Người phụ trách: `implementation/README.md §2`.

| | |
|---|---|
| **Liên quan** | `architecture.md §6`, `standards/coding-convention.md §2–3`, ADR-0014 |
| **Chủ sở hữu / Cập nhật / Phiên bản** | hoang.lv — 2026-11-16 — v1.0 |

## 1. Cây thư mục

```
Realestate_Microservice/
├─ .github/
│  ├─ CODEOWNERS                      ✓
│  ├─ PULL_REQUEST_TEMPLATE.md        ✓
│  └─ workflows/ci.yml                + (T1.1)
├─ .claude/                           + bộ công cụ Claude Code (playbooks.json, settings.json, agents/, skills/)
├─ .editorconfig .gitattributes .gitignore .nvmrc .prettierrc .prettierignore   ✓
├─ .env.example                       ✓ (biến thời gian còn theo luồng cũ, xem van-de A3)
├─ eslint.config.mjs  package.json  pnpm-workspace.yaml  pnpm-lock.yaml  tsconfig.base.json   ✓
├─ README.md                          ✓
├─ scripts/generate-jwt-keys.mjs      ✓ (pnpm keys:generate)
├─ secrets/                           ✓ khóa JWT, không commit
│
├─ contracts/                         ✓ nguồn sự thật API nội bộ và sự kiện (ADR-0012)
│  ├─ openapi/
│  │  ├─ README.md                    ✓
│  │  ├─ listing-internal.v1.yaml     ✓ (cập nhật T0.3)
│  │  ├─ rental-internal.v1.yaml      ✓ (viết lại T0.3)
│  │  ├─ payment-internal.v1.yaml     + (T0.3)
│  │  └─ identity-internal.v1.yaml    + (T0.3)
│  ├─ events/                         ✓ envelope + schema; bổ sung theo RE.MESSAGING §3 (T0.4)
│  └─ scripts/                        ✓ check-events.mjs, check-openapi.mjs
│
├─ infra/
│  ├─ compose/
│  │  ├─ docker-compose.yml           ✓ profile dev, demo; + profile apps (T1.3)
│  │  └─ postgres/init/01-create-databases.sh   ✓ 5 DB, 5 user
│  ├─ rabbitmq/definitions.json, rabbitmq.conf  ✓ (binding mới T0.4)
│  ├─ scripts/check-infra.ps1, check-infra.sh   ✓
│  ├─ elk/                            ✓ (mở rộng X2)
│  ├─ k6/                             + kịch bản E1–E3, snapshot (T6.1)
│  └─ postman/                        + collection, environment (T5.2)
│
├─ services/
│  ├─ _template-nest/                 ✓ khung kỹ thuật (RE.SERVICE_TEMPLATE)
│  │  └─ src/ common/ config/ database/ health/ messaging/ redis/ storage/ example/ scripts/
│  │
│  ├─ api-gateway/                    + cổng 8080, không DB (RE.GATEWAY)
│  │  └─ src/gateway/ routes.ts, route-resolver.ts, access.guard.ts,
│  │                  internal-block.middleware.ts, throttle.config.ts, proxy.middleware.ts, errors/
│  │
│  ├─ identity/                       ✓ cổng 3001, identity_db + Redis (RE.IDENTITY)
│  │  └─ src/identity/
│  │     ├─ controllers/ auth.controller.ts ✓; + bank-account, users.admin, users.internal
│  │     ├─ services/ auth, password, token ✓; + bank-account, user-admin
│  │     ├─ stores/ dto/ entities/ errors/ config/ seed/   ✓
│  │
│  ├─ listing/                        ✓ T2.2 (route 1–10, 12, mine); T2.3 thêm search, internal. Cổng 3002, listing_db (PostGIS) + S3 (RE.LISTING)
│  │  └─ src/listing/
│  │     ├─ controllers/ listings, listings.admin, listings.internal, locations (T2.6, RE.LOCATION — đề xuất)
│  │     ├─ services/ listing-command, listing-query, listing-search.sql, listing-review, listing-image, listing-hold (+ .rules), location-query (T2.6)
│  │     └─ dto/ entities/ errors/ seed/
│  │
│  ├─ rental/                         ✓ T3.2 (lịch xem, saga luồng thành công, payment.deposited); + T3.3–T3.5. Cổng 3003, rental_db + Redis (RE.VIEWING, RE.DEPOSIT_SAGA, RE.DEPOSIT_LIFECYCLE)
│  │  └─ src/rental/
│  │     ├─ controllers/ deposits, deposits.admin, deposits.internal, viewings
│  │     ├─ services/ deposit-saga, compensation, listing-sync, deposit-lifecycle, deposit-query, viewing
│  │     ├─ locks/listing.lock.ts
│  │     ├─ clients/ listing.client.ts, payment.client.ts
│  │     ├─ events/payment-events.handler.ts
│  │     ├─ jobs/ hold-expiry, saga-reconcile, deadline, auto-release
│  │     ├─ domain/deposit-state.ts
│  │     └─ entities/ dto/ errors/ config/
│  │
│  ├─ payment/                        ✓ T3.1 (khung, payment order, payOS); + T3.4 webhook, T3.6 payout. Cổng 3004, payment_db + S3 (RE.PAYMENT, RE.PAYOUT)
│  │  └─ src/payment/
│  │     ├─ controllers/ payos-webhook, payment-orders.internal, refund-requests.internal,
│  │     │               withdrawals, payouts.admin, transactions
│  │     ├─ services/ payment-order, webhook, deposit-capture, wallet, refund, withdrawal, receipt, audit, payout-query
│  │     ├─ clients/ payos.client.ts, rental.client.ts, identity.client.ts
│  │     ├─ domain/refund-amount.ts
│  │     ├─ http/receipt-too-large.interceptor.ts
│  │     └─ entities/ dto/ errors/ config/
│  │
│  └─ notification/                   + cổng 3005, notification_db (RE.NOTIFICATION, RE.CHAT)
│     └─ src/
│        ├─ notification/ controllers/ services/ events/ (domain-events.handler, message-templates)
│        │               realtime/realtime.gateway.ts entities/ errors/
│        └─ chat/ controllers/ services/ (conversation, message) entities/ dto/
│
├─ docs/                              ✓ tài liệu cũ: architecture/, adr/, pm/, runbook/, Bao_cao_Real-estate.docx
│
└─ project-knowledge/                 tài liệu dự án, cổng vào là CLAUDE.md
   ├─ CLAUDE.md, architecture.md, domain-glossary.md, project-structure.md, requirements-traceability.md
   ├─ business-spec/                  README.md, RE.BUSINESS_RULES.md
   ├─ design/                         README.md, _template/, SHARED/, IDENTITY/, LISTING/, RENTAL/, PAYMENT/, NOTIFICATION/
   ├─ decisions/                      README.md, _template.md, 0001–0014
   ├─ standards/                      api, coding, reliability, non-functional, security, design, git, gotchas
   ├─ guides/                         RE_*_Guide.md (5)
   ├─ implementation/                 README, progress, PHASE-0…7, van-de-can-quyet-dinh
   └─ playbooks/                      README.md, tdd/ (tdd-guide.md, tdd-guard.js)
```

Mỗi service có thêm: `Dockerfile`, `Dockerfile.dockerignore`, `package.json` (`@realestate/<service>`), `nest-cli.json`, `.env.example`, `openapi.json`, `scripts/ensure-env.mjs`, `test/` (e2e, infra, helpers), `src/` phần dùng chung copy từ template, `src/database/migrations/`.

## 2. Cách đọc

| Phần | Ý nghĩa |
|---|---|
| `src/<miền>/` | Module nghiệp vụ theo mẫu `services/identity/src/identity/` (`coding-convention.md §2`) |
| `controllers/*.internal.controller.ts` | API cho service khác, `@Public`, `@ApiExcludeController`, gateway chặn |
| `clients/` | Nơi duy nhất gọi service khác hoặc payOS. Listing và notification không có thư mục này |
| `jobs/` | Công việc nền; chỉ rental có |
| `domain/` | Hàm thuần, test không cần hạ tầng |
| `http/` | Interceptor, pipe riêng của module (payment: đổi lỗi cỡ tệp multer sang mã của thiết kế) |
| `errors/<miền>.errors.ts` | Mã lỗi `<MIỀN>_*`, khớp catalog trong `API_Spec.md` |
| `src/messaging/`, `src/storage/` | Từ template; bật bằng biến môi trường |

## 3. Lưu ý

- Không có package dùng chung; phần kỹ thuật là bản sao từ template trong mỗi service (ADR-0014).
- `assistant` (cổng 3006) không nằm trong cây: mở rộng X5.
- Giao diện Next.js nằm ở repo riêng: https://github.com/dotrungthanhCC01/real-estate. Repo này chỉ chứa backend.
- `docs/` chỉ còn `pm/` (kế hoạch sprint, giao việc) và `runbook/`; tài liệu cũ đã xóa (B14, B16).

## 4. Đã chốt 2026-11-16

1. `docs/` cũ: xóa, chỉ giữ `pm/` và `runbook/` (B16).
2. Tên tệp gateway theo `design/SHARED/RE.GATEWAY/Component_Class_Design.md §1` (proxy bằng `http-proxy-middleware`).
