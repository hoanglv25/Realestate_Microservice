# RE.DEPOSIT_LIFECYCLE — Luồng xử lý

| | |
|---|---|
| **Chức năng** | Bàn giao, nhận phòng hoặc hoàn tiền, tự giải ngân, điều kiện rút |
| **Tham chiếu** | `API_Spec.md`, `Component_Class_Design.md`, Báo cáo v2 Hình 3.3–3.5, 3.10–3.11 |
| **Chủ sở hữu / Cập nhật / Phiên bản** | hoang.lv — 2026-11-25 — v1.2 |

## 1. Bàn giao và chủ trọ xác nhận (BR-11)

```mermaid
sequenceDiagram
    participant A as Quản trị viên
    participant R as rental
    participant N as notification
    participant O as Chủ trọ
    A->>R: GET /admin/deposits?status=PAID
    A->>R: POST /admin/deposits/:id/hand-over
    R->>R: BEGIN, admin_confirmed_at = now() WHERE status IN (PAID, RELEASED) AND admin_confirmed_at IS NULL, audit_log HAND_OVER, outbox deposit-handed-over, COMMIT
    R-->>A: 200
    R--)N: rental.deposit-handed-over
    N--)O: thông báo
    O->>R: POST /deposits/:id/acknowledge
    R-->>O: 200, đơn vào danh sách của chủ trọ, nút Rút tiền khóa tới khi RELEASED
```

Bàn giao không đổi trạng thái: tiền vẫn nằm ở ví trung gian, chỉ quyết định đơn đã hiện ở phía chủ trọ chưa.

## 2. Nhận phòng, hoàn tiền hoặc chờ (BR-12, BR-13)

```mermaid
flowchart TD
    P[PAID] -->|Người thuê bấm Đã nhận phòng, hỏi lại trước| RL[RELEASED, trigger TENANT]
    P -->|Yêu cầu hoàn, còn trong 48h| RR[REFUND_REQUESTED]
    P -->|Không làm gì: nhắc ở 48h, tự giải ngân ở 72h| RA[RELEASED, trigger AUTO]
    RR -->|Quản trị viên hoàn xong + chứng từ| RF[REFUNDED, BĐS AVAILABLE]
    RR -->|Quản trị viên từ chối| P
    RR -->|Chuyển khoản thất bại| RR
    RF -->|Chủ trọ rút phần còn lại 30%, không cần bàn giao| W30[Đơn giữ REFUNDED, có withdrawn_at]
    RL --> W[Chủ trọ tạo lệnh rút]
    RA --> W
    W -->|Hoàn tất + chứng từ| WD[WITHDRAWN]
```

Hạn hoàn (48 giờ) kết thúc trước hạn tự giải ngân (72 giờ) 24 giờ, nên bình thường hai luồng không chồng nhau.

## 3. Yêu cầu hoàn

```mermaid
sequenceDiagram
    participant T as Người thuê
    participant R as rental
    participant P as payment
    participant A as Quản trị viên
    T->>R: POST /deposits/:id/refund-request + Idempotency-Key
    R->>R: UPDATE ... WHERE status='PAID' AND refund_deadline_at >= now() → REFUND_REQUESTED
    R->>P: POST /internal/refund-requests {depositId}
    P->>P: 70% của amount, PENDING_ADMIN
    P-->>R: 201
    R-->>T: 200 REFUND_REQUESTED
    A->>P: hoàn tất + chứng từ
    P--)R: payment.refunded
    R->>R: REFUNDED, đích listing AVAILABLE
```

## 4. Bảng xử lý lỗi

| Điểm lỗi | Xử lý | Kết quả |
|---|---|---|
| Payment dừng khi tạo yêu cầu hoàn | Đơn đã `REFUND_REQUESTED`; job (c) gửi lại | Tự giải ngân đã dừng; yêu cầu tới payment muộn |
| Yêu cầu hoàn đúng lúc `AutoReleaseJob` chạy | Cả hai `UPDATE ... WHERE status='PAID'`; bên 0 dòng thua | Một trạng thái cuối (E7) |
| Listing dừng khi đồng bộ `RENTED`/`AVAILABLE` | Job (b) đẩy lại | BĐS hiển thị trễ |
| Sự kiện payment đến sai thứ tự | `UPDATE` có điều kiện 0 dòng → bỏ qua | Không đổi sai |
| Identity dừng | Không ảnh hưởng (rental không gọi identity) | |

## 5. Bất biến

| Bất biến | Kiểm tra |
|---|---|
| Mỗi đơn tối đa một kết cục `WITHDRAWN` hoặc `REFUNDED` (BR-16) | Bảng chuyển; không có đường từ `REFUNDED`/`WITHDRAWN`. Lệnh rút phần còn lại của đơn `REFUNDED` không đổi trạng thái |
| Không có đơn `PAID` quá `auto_release_at` + 2 chu kỳ job | Truy vấn |
| Đơn `RELEASED` thì BĐS `RENTED`; `REFUNDED` thì `AVAILABLE` | Đối chiếu sau khi job đồng bộ xong |
