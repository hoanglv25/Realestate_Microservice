import { Body, Controller, Get, HttpCode, HttpStatus, Param, Post, Query } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiConflictResponse,
  ApiForbiddenResponse,
  ApiHeader,
  ApiNotFoundResponse,
  ApiOperation,
  ApiServiceUnavailableResponse,
  ApiTags,
} from '@nestjs/swagger';
import type { AuthUser } from '../../common/auth/authenticated-user';
import { CurrentUser } from '../../common/auth/current-user.decorator';
import { Roles } from '../../common/auth/roles.decorator';
import { ErrorResponseDto } from '../../common/errors/error-response.dto';
import { createUuidParamPipe } from '../../common/errors/uuid-param.pipe';
import { Idempotent } from '../../common/idempotency/idempotent.decorator';
import { ApiEnvelope } from '../../common/response/api-envelope.decorator';
import type { Paginated } from '../../common/response/response-meta';
import {
  CreateDepositDto,
  DepositCreatedDto,
  DepositDto,
  ListDepositsQuery,
} from '../dto/deposit.dto';
import { DepositLifecycleService } from '../services/deposit-lifecycle.service';
import { DepositQueryService } from '../services/deposit-query.service';
import { DepositSagaService } from '../services/deposit-saga.service';

const idPipe = createUuidParamPipe('id');

/**
 * Đơn đặt cọc: /api/v1/deposits. Đặt cọc: `RE.DEPOSIT_SAGA/API_Spec.md §1`. Vòng đời đơn (T3.5):
 * `RE.DEPOSIT_LIFECYCLE/API_Spec.md §1` route 1, 2, 3, 4, 7. Người gọi luôn là `sub` của JWT.
 */
@ApiTags('deposits')
@ApiBearerAuth()
@Controller('deposits')
export class DepositsController {
  constructor(
    private readonly saga: DepositSagaService,
    private readonly queries: DepositQueryService,
    private readonly lifecycle: DepositLifecycleService,
  ) {}

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

  @Get('mine')
  @Roles('TENANT', 'LANDLORD')
  @ApiOperation({
    summary:
      'Route 1 — Đơn của tôi (người thuê: đơn mình đặt; chủ trọ: đơn đã xác nhận hoặc REFUNDED của tin mình)',
  })
  @ApiEnvelope(DepositDto, { isArray: true })
  findMine(
    @CurrentUser() user: AuthUser,
    @Query() query: ListDepositsQuery,
  ): Promise<Paginated<DepositDto>> {
    return this.queries.findMine(user, query);
  }

  @Get(':id')
  @Roles('TENANT', 'LANDLORD', 'ADMIN')
  @ApiOperation({ summary: 'Route 2 — Chi tiết đơn (BR-19), kèm allowedActions' })
  @ApiEnvelope(DepositDto)
  @ApiNotFoundResponse({ type: ErrorResponseDto, description: 'RENTAL_DEPOSIT_NOT_FOUND' })
  @ApiForbiddenResponse({ type: ErrorResponseDto, description: 'FORBIDDEN' })
  findOne(@CurrentUser() user: AuthUser, @Param('id', idPipe) id: string): Promise<DepositDto> {
    return this.queries.findOne(user, id);
  }

  @Post(':id/confirm-move-in')
  @HttpCode(200)
  @Roles('TENANT')
  @ApiOperation({ summary: 'Route 3 — Người thuê xác nhận đã nhận phòng: PAID → RELEASED (BR-13)' })
  @ApiEnvelope(DepositDto)
  @ApiNotFoundResponse({ type: ErrorResponseDto, description: 'RENTAL_DEPOSIT_NOT_FOUND' })
  @ApiForbiddenResponse({ type: ErrorResponseDto, description: 'FORBIDDEN' })
  @ApiConflictResponse({ type: ErrorResponseDto, description: 'RENTAL_INVALID_TRANSITION' })
  confirmMoveIn(
    @CurrentUser() user: AuthUser,
    @Param('id', idPipe) id: string,
  ): Promise<DepositDto> {
    return this.lifecycle.confirmMoveIn(user, id);
  }

  @Post(':id/refund-request')
  @HttpCode(200)
  @Roles('TENANT')
  @Idempotent()
  @ApiOperation({
    summary: 'Route 4 — Yêu cầu hoàn 70% trong 48 giờ: PAID → REFUND_REQUESTED (BR-12)',
  })
  @ApiHeader({ name: 'Idempotency-Key', required: true })
  @ApiEnvelope(DepositDto)
  @ApiNotFoundResponse({ type: ErrorResponseDto, description: 'RENTAL_DEPOSIT_NOT_FOUND' })
  @ApiForbiddenResponse({ type: ErrorResponseDto, description: 'FORBIDDEN' })
  @ApiConflictResponse({
    type: ErrorResponseDto,
    description: 'RENTAL_INVALID_TRANSITION, RENTAL_REFUND_WINDOW_CLOSED',
  })
  requestRefund(
    @CurrentUser() user: AuthUser,
    @Param('id', idPipe) id: string,
  ): Promise<DepositDto> {
    return this.lifecycle.requestRefund(user, id);
  }

  @Post(':id/acknowledge')
  @HttpCode(200)
  @Roles('LANDLORD')
  @ApiOperation({ summary: 'Route 7 — Chủ trọ xác nhận đơn đã bàn giao (BR-11)' })
  @ApiEnvelope(DepositDto)
  @ApiNotFoundResponse({ type: ErrorResponseDto, description: 'RENTAL_DEPOSIT_NOT_FOUND' })
  @ApiForbiddenResponse({ type: ErrorResponseDto, description: 'FORBIDDEN' })
  @ApiConflictResponse({ type: ErrorResponseDto, description: 'RENTAL_NOT_HANDED_OVER' })
  acknowledge(@CurrentUser() user: AuthUser, @Param('id', idPipe) id: string): Promise<DepositDto> {
    return this.lifecycle.acknowledge(user, id);
  }
}
