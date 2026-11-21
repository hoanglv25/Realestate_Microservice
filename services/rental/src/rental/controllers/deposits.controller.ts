import { Body, Controller, HttpStatus, Post } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiConflictResponse,
  ApiHeader,
  ApiNotFoundResponse,
  ApiOperation,
  ApiServiceUnavailableResponse,
  ApiTags,
} from '@nestjs/swagger';
import { CurrentUser } from '../../common/auth/current-user.decorator';
import { Roles } from '../../common/auth/roles.decorator';
import { ErrorResponseDto } from '../../common/errors/error-response.dto';
import { Idempotent } from '../../common/idempotency/idempotent.decorator';
import { ApiEnvelope } from '../../common/response/api-envelope.decorator';
import { CreateDepositDto, DepositCreatedDto } from '../dto/deposit.dto';
import { DepositSagaService } from '../services/deposit-saga.service';

/** Đơn đặt cọc: /api/v1/deposits (`RE.DEPOSIT_SAGA/API_Spec.md §1`). Route vòng đời đơn thêm ở T3.5. */
@ApiTags('deposits')
@ApiBearerAuth()
@Controller('deposits')
export class DepositsController {
  constructor(private readonly saga: DepositSagaService) {}

  @Post()
  @Roles('TENANT')
  @Idempotent()
  @ApiOperation({ summary: 'Đặt cọc: giữ chỗ tin và tạo link payOS (số tiền lấy từ tin, BR-04)' })
  @ApiHeader({ name: 'Idempotency-Key', required: true })
  @ApiEnvelope(DepositCreatedDto, { status: HttpStatus.CREATED })
  @ApiNotFoundResponse({ type: ErrorResponseDto, description: 'LISTING_NOT_FOUND' })
  @ApiConflictResponse({
    type: ErrorResponseDto,
    description: 'LISTING_NOT_AVAILABLE, RENTAL_DEPOSIT_IN_PROGRESS, IDEMPOTENCY_IN_PROGRESS',
  })
  @ApiServiceUnavailableResponse({ type: ErrorResponseDto, description: 'UPSTREAM_UNAVAILABLE' })
  create(
    @CurrentUser('sub') tenantId: string,
    @Body() dto: CreateDepositDto,
  ): Promise<DepositCreatedDto> {
    return this.saga.start(tenantId, dto.listingId);
  }
}
