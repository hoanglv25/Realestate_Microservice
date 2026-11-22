import { Inject, Injectable } from '@nestjs/common';
import { InjectDataSource, InjectRepository } from '@nestjs/typeorm';
import { PinoLogger } from 'nestjs-pino';
import { DataSource, Repository } from 'typeorm';
import { PayosClient } from '../clients/payos.client';
import { PaymentOrder } from '../entities/payment-order.entity';
import { isUniqueViolation } from '../errors/payment.errors';
import { AcceptedPayment, DepositCaptureService } from './deposit-capture.service';

/**
 * `payos_webhook_events.result` (`API_Spec §1`). `RECEIVED` là trạng thái tạm giữa lúc lưu nguyên văn và lúc biết
 * kết quả; còn lại ở `RECEIVED` nghĩa là payment dừng giữa chừng (payOS sẽ gửi lại).
 */
export type WebhookResult =
  | 'RECEIVED'
  | 'INVALID_SIGNATURE'
  | 'IGNORED'
  | 'UNKNOWN_ORDER'
  | 'AMOUNT_MISMATCH'
  | 'DUPLICATE'
  | 'PAID'
  | 'LATE';

/** Một `reference` chỉ được ghi nhận (`PAID`/`LATE`) một lần (index một phần, migration T3.1). */
const ACCEPTED_REFERENCE_UNIQUE = 'ux_webhook_accepted_reference';
const REFERENCE_MAX = 100; // payos_webhook_events.reference varchar(100)

const INSERT_EVENT = `
  INSERT INTO payos_webhook_events (order_code, reference, amount_vnd, signature_valid, result, raw)
  VALUES ($1, $2, $3, $4, $5, $6::jsonb)
  RETURNING id`;
const SET_RESULT = `UPDATE payos_webhook_events SET result = $2 WHERE id = $1`;

/** `transactionDateTime` của payOS: `YYYY-MM-DD HH:mm:ss`, giờ Việt Nam. */
const PAYOS_DATETIME = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/;

interface Fields {
  orderCode: number | null;
  reference: string | null;
  amountVnd: number | null;
  transactionDateTime: string | null;
  success: boolean;
}

const asObject = (v: unknown): Record<string, unknown> | null =>
  typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
const positiveInt = (v: unknown): number | null =>
  typeof v === 'number' && Number.isSafeInteger(v) && v > 0 ? v : null;

/** Lấy các trường cần lưu cột và quyết định; trường sai kiểu thành `null` (nguyên văn vẫn giữ ở `raw`). */
function readFields(raw: unknown): Fields {
  const body = asObject(raw);
  const data = asObject(body?.data);
  const reference = data?.reference;
  return {
    orderCode: positiveInt(data?.orderCode),
    reference:
      typeof reference === 'string' && reference.length > 0 && reference.length <= REFERENCE_MAX
        ? reference
        : null,
    amountVnd: positiveInt(data?.amount),
    transactionDateTime:
      typeof data?.transactionDateTime === 'string' ? data.transactionDateTime : null,
    success: body?.success === true && body?.code === '00',
  };
}

/**
 * Nhận webhook payOS (`RE.PAYMENT/API_Spec.md §1`, `Component_Class_Design §3`, `Processing_Flow §2`).
 *
 * - Luôn lưu nguyên văn vào `payos_webhook_events` **trước** mọi kiểm tra.
 * - Trả về kết quả cho test và log; controller luôn trả `200` cho payOS (đã lưu), chỉ ném khi DB lỗi để payOS gửi lại.
 * - Mọi thay đổi tiền nằm trong MỘT transaction (`DepositCaptureService`). Không gọi mạng trong transaction.
 * - Trùng `reference`: index `ux_webhook_accepted_reference` chặn ở câu ghi `result` → rollback → `DUPLICATE`.
 *
 * Truy vấn (`Processing_Flow §6`, ngưỡng 8): `PAID` 7, `LATE` 8, nhánh đua (UPDATE order 0 dòng → `LATE`) 9 (A chấp
 * nhận 2026-11-22), sai chữ ký/bỏ qua 1, không có order/sai số tiền 3.
 */
@Injectable()
export class WebhookService {
  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    @InjectRepository(PaymentOrder) private readonly orders: Repository<PaymentOrder>,
    @Inject(PayosClient) private readonly payos: PayosClient,
    @Inject(DepositCaptureService) private readonly capture: DepositCaptureService,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(WebhookService.name);
  }

  async handle(raw: unknown): Promise<WebhookResult> {
    const signatureValid = await this.payos.verify(raw);
    const f = readFields(raw);
    const usable =
      f.success && f.orderCode !== null && f.amountVnd !== null && f.reference !== null;
    const initial: WebhookResult = !signatureValid
      ? 'INVALID_SIGNATURE'
      : !usable
        ? 'IGNORED'
        : 'RECEIVED';

    // Dòng 1: luôn lưu nguyên văn (kể cả sai chữ ký) — bằng chứng đối soát
    const [saved] = (await this.dataSource.query(INSERT_EVENT, [
      f.orderCode,
      f.reference,
      f.amountVnd,
      signatureValid,
      initial,
      JSON.stringify(raw ?? null),
    ])) as Array<{ id: string }>;
    const ctx = { webhookEventId: saved.id, orderCode: f.orderCode };

    if (initial === 'INVALID_SIGNATURE') {
      this.logger.warn({ ...ctx, result: initial }, 'Webhook payOS sai chữ ký, bỏ qua'); // Báo cáo T09
      return initial;
    }
    if (initial === 'IGNORED') {
      this.logger.info(
        { ...ctx, result: initial },
        'Webhook payOS không phải giao dịch thành công',
      );
      return initial;
    }

    const order = await this.orders.findOneBy({ payosOrderCode: f.orderCode as number });
    if (!order) return this.mark(saved.id, 'UNKNOWN_ORDER', ctx, 'warn');
    // Dòng 5: sai số tiền chỉ xét order PENDING; CANCELLED/PAID ghi tiền đến muộn với số thực nhận (§7 mục 2)
    if (order.status === 'PENDING' && f.amountVnd !== order.amountVnd) {
      return this.mark(saved.id, 'AMOUNT_MISMATCH', ctx, 'warn');
    }

    const paid: AcceptedPayment = {
      reference: f.reference as string,
      amountVnd: f.amountVnd as number,
      paidAt: this.paidAt(f.transactionDateTime, ctx),
    };
    try {
      const result = await this.dataSource.transaction(async (m): Promise<WebhookResult> => {
        if (order.status === 'PENDING' && (await this.capture.capture(m, order, paid))) {
          await m.query(SET_RESULT, [saved.id, 'PAID']); // trùng reference -> lỗi unique ở đây
          return 'PAID';
        }
        // Order CANCELLED, PAID (reference khác), hoặc vừa thua lệnh hủy: tiền đến muộn (§1.2)
        await m.query(SET_RESULT, [saved.id, 'LATE']);
        await this.capture.recordLate(m, order, paid);
        return 'LATE';
      });
      this.logger.info({ ...ctx, result, amountVnd: paid.amountVnd }, 'Đã ghi nhận webhook payOS');
      return result;
    } catch (err) {
      if (isUniqueViolation(err, ACCEPTED_REFERENCE_UNIQUE)) {
        return this.mark(saved.id, 'DUPLICATE', ctx, 'info'); // Báo cáo T10
      }
      throw err; // 500: payOS gửi lại, unique chống ghi trùng
    }
  }

  private async mark(
    id: string,
    result: WebhookResult,
    ctx: Record<string, unknown>,
    level: 'info' | 'warn',
  ): Promise<WebhookResult> {
    await this.dataSource.query(SET_RESULT, [id, result]);
    this.logger[level]({ ...ctx, result }, 'Webhook payOS không ghi nhận tiền');
    return result;
  }

  /** `YYYY-MM-DD HH:mm:ss` giờ VN → `Date`. Sai dạng: lấy giờ hiện tại (không chặn ghi nhận tiền), log `warn`. */
  private paidAt(value: string | null, ctx: Record<string, unknown>): Date {
    if (value && PAYOS_DATETIME.test(value)) {
      const d = new Date(`${value.replace(' ', 'T')}+07:00`);
      if (!Number.isNaN(d.getTime())) return d;
    }
    this.logger.warn(ctx, 'transactionDateTime của payOS sai dạng, dùng giờ hiện tại');
    return new Date();
  }
}
