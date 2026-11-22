import { Body, Controller, HttpCode, Post } from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Public } from '../../common/auth/public.decorator';
import { WebhookService } from '../services/webhook.service';

/** Body trả payOS: cố định, không lộ kết quả xử lý ra ngoài (A duyệt 2026-11-22). */
export interface WebhookAck {
  received: true;
}

/**
 * Webhook payOS (`RE.PAYMENT/API_Spec.md §1`): `POST /api/v1/payments/payos/webhook`.
 *
 * - `@Public()`: payOS không có token. Gateway cho qua với quyền `payos` và chuyển tiếp nguyên body
 *   (`RE.GATEWAY`); xác thực bằng chữ ký `PAYOS_CHECKSUM_KEY` trong `WebhookService`.
 * - Luôn `200` khi đã lưu webhook (kể cả sai chữ ký, trùng, không có order) để payOS không gửi lại vô hạn;
 *   `5xx` chỉ khi DB lỗi để payOS gửi lại.
 * - `@Body()` kiểu `object` thuần: không qua class-validator, giữ nguyên mọi trường để lưu nguyên văn và kiểm chữ
 *   ký trên đúng `data` payOS gửi.
 */
@ApiTags('payments')
@Public()
@Controller('payments/payos')
export class PayosWebhookController {
  constructor(private readonly webhooks: WebhookService) {}

  @Post('webhook')
  @HttpCode(200)
  @ApiOperation({ summary: 'Webhook payOS (không token, kiểm chữ ký)' })
  @ApiOkResponse({ description: 'Đã nhận và lưu webhook' })
  async receive(@Body() body: object): Promise<WebhookAck> {
    await this.webhooks.handle(body);
    return { received: true };
  }
}
