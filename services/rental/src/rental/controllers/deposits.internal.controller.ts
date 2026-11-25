import { Controller, Get, Param } from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import { Public } from '../../common/auth/public.decorator';
import { createUuidParamPipe } from '../../common/errors/uuid-param.pipe';
import { WithdrawalEligibilityDto } from '../dto/deposit.dto';
import { DepositLifecycleService } from '../services/deposit-lifecycle.service';

/**
 * API NỘI BỘ của rental (/internal/deposits/...): chỉ payment gọi (S4), KHÔNG gắn prefix /api/v1, không có trong
 * Swagger công khai, gateway trả 404 cho /internal/* từ bên ngoài. Hợp đồng: `contracts/openapi/rental-internal.v1.yaml`.
 * Thiết kế: `RE.DEPOSIT_LIFECYCLE/API_Spec.md §2`.
 *
 * @Public(): tin mạng Docker (hạn chế đã biết, `security-policy.md §6`), như `/internal/*` của listing, payment.
 */
@ApiExcludeController()
@Public()
@Controller('internal/deposits')
export class DepositsInternalController {
  constructor(private readonly lifecycle: DepositLifecycleService) {}

  /** Điều kiện rút (BR-15 sửa): `200` cả khi `eligible = false` (kèm `missing`); không có đơn → `404`. */
  @Get(':id/withdrawal-eligibility')
  withdrawalEligibility(
    @Param('id', createUuidParamPipe('id')) id: string,
  ): Promise<WithdrawalEligibilityDto> {
    return this.lifecycle.withdrawalEligibility(id);
  }
}
