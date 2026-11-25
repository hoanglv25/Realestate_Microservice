import { Body, Controller, Post, Res } from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import type { Response } from 'express';
import { Public } from '../../common/auth/public.decorator';
import { CreateRefundRequestDto } from '../dto/payout.dto';
import type { InternalRefundDto } from '../dto/payout.dto';
import { RefundService } from '../services/refund.service';

/**
 * API NỘI BỘ: rental tạo yêu cầu hoàn 70% cho đơn người thuê tự hủy (`RE.PAYOUT/API_Spec.md §2`, BR-12). Hợp đồng:
 * `contracts/openapi/payment-internal.v1.yaml` (`createRefundRequest`). Không prefix /api/v1, không Swagger công khai;
 * gateway trả 404 cho /internal/* từ bên ngoài. `@Public()`: tin mạng Docker như các API nội bộ khác.
 */
@ApiExcludeController()
@Public()
@Controller('internal/refund-requests')
export class RefundRequestsInternalController {
  constructor(private readonly refunds: RefundService) {}

  /** `201` tạo mới; `200` đơn đã có yêu cầu của người thuê (gọi lại an toàn: rental job (c) gửi lại). */
  @Post()
  async create(
    @Body() dto: CreateRefundRequestDto,
    @Res({ passthrough: true }) res: Response,
  ): Promise<InternalRefundDto> {
    const { created, view } = await this.refunds.createForTenant(dto.depositId);
    res.status(created ? 201 : 200);
    return view;
  }
}
