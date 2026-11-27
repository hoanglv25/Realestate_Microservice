# RE.SERVICE_TEMPLATE — Luồng xử lý

| | |
|---|---|
| **Chức năng** | Vòng đời request, gọi service khác, idempotency, lỗi về client |
| **Tham chiếu** | `API_Spec.md`, `Component_Class_Design.md`, `standards/reliability-standard.md` |
| **Chủ sở hữu / Cập nhật / Phiên bản** | hoang.lv — 2026-11-26 — v2.2 |

## 1. Vòng đời một request

```mermaid
sequenceDiagram
    participant C as Gateway / client
    participant M as Middleware (app.use)
    participant G as JwtAuthGuard + RolesGuard
    participant I as IdempotencyInterceptor
    participant H as Controller → Service
    participant E as ResponseEnvelopeInterceptor
    participant F as AllExceptionsFilter
    C->>M: request + X-Request-ID
    M->>M: correlationId (thiếu thì sinh UUID), access log
    M->>G: 
    alt token thiếu/sai/hết hạn, thiếu vai trò
        G-->>F: AppException 401/403
    end
    G->>I: (chỉ route @Idempotent)
    alt khóa đã có kết quả
        I-->>E: kết quả cũ
    end
    I->>H: xử lý
    H-->>E: dữ liệu thuần
    E-->>C: { data, meta }
    H--xF: lỗi
    F-->>C: { error, meta } + header X-Request-ID
```

## 2. Gọi service khác

```mermaid
sequenceDiagram
    participant S as Service A
    participant H as InternalHttpService
    participant B as Service B
    S->>H: post(url, body, { idempotent: true, timeoutMs })
    H->>B: + X-Request-ID
    alt 2xx
        B-->>H: { data, meta }
        H-->>S: data
    else 4xx
        B-->>H: { error }
        H-->>S: AppException (status, code giữ nguyên)
    else timeout / mất kết nối / 502-504
        H->>H: chờ 100 ms, 200 ms, thử lại (nếu được phép)
        H-->>S: 503 UPSTREAM_UNAVAILABLE hoặc 504 UPSTREAM_TIMEOUT
    end
```

Không gọi khi đang giữ transaction (`coding-convention.md §4`).

## 3. Idempotency-Key

| Trạng thái khóa trong Redis | Hành vi |
|---|---|
| Chưa có | Ghi `IN_PROGRESS` (NX), chạy handler, lưu kết quả thuần + fingerprint body, TTL `IDEMPOTENCY_TTL_SECONDS` |
| `IN_PROGRESS` | `409 IDEMPOTENCY_IN_PROGRESS` |
| Có kết quả, cùng fingerprint | Trả lại kết quả, bọc `meta` của request mới |
| Có kết quả, khác fingerprint | `422 IDEMPOTENCY_KEY_REUSED` |
| Handler lỗi (cả `4xx` và `5xx`) | Xóa khóa; gửi lại cùng khóa sẽ chạy lại handler (`idempotency.interceptor.ts`, đã kiểm 2026-11-16) |

## 4. Khởi động và tắt

1. `env.bootstrap.ts` nạp `.env`; `env.validation.ts` kiểm, thiếu biến → in danh sách, thoát mã 1.
2. Module tùy chọn bật theo env có mặt.
3. `StorageModule` không gọi S3 lúc khởi động; bucket trong `S3_BUCKETS` tạo sẵn (v2.2, ADR-0016). Kết nối kiểm qua health `s3`.
4. SIGTERM → `ShutdownLoggerService` ghi trình tự; đóng kết nối gọn.

## 5. Đã chốt

Xóa khóa idempotency với mọi lỗi của handler (§3), theo code template.
