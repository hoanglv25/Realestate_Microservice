import { Body, Controller, Get, HttpStatus, Post, Query } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiConflictResponse,
  ApiForbiddenResponse,
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
import { PageQueryDto } from '../../common/response/page-query.dto';
import type { Paginated } from '../../common/response/response-meta';
import { CreateWithdrawalDto, WithdrawalDto } from '../dto/payout.dto';
import { PayoutQueryService } from '../services/payout-query.service';
import { WithdrawalService } from '../services/withdrawal.service';

/** Lệnh rút của chủ trọ: route 2, 3 (`RE.PAYOUT/API_Spec.md §1, §1.1`). */
@ApiTags('withdrawals')
@ApiBearerAuth()
@Controller('withdrawals')
export class WithdrawalsController {
  constructor(
    private readonly withdrawals: WithdrawalService,
    private readonly queries: PayoutQueryService,
  ) {}

  @Post()
  @Roles('LANDLORD')
  @Idempotent()
  @ApiOperation({ summary: 'Route 2 — Tạo lệnh rút (số tiền do payment tính, BR-15)' })
  @ApiEnvelope(WithdrawalDto, { status: HttpStatus.CREATED })
  @ApiForbiddenResponse({
    type: ErrorResponseDto,
    description: 'FORBIDDEN: không phải chủ trọ của đơn',
  })
  @ApiNotFoundResponse({ type: ErrorResponseDto, description: 'RENTAL_DEPOSIT_NOT_FOUND' })
  @ApiConflictResponse({
    type: ErrorResponseDto,
    description:
      'PAYMENT_WITHDRAWAL_NOT_ELIGIBLE (details.missing), PAYMENT_PAYOUT_ALREADY_OPEN, PAYMENT_BANK_ACCOUNT_MISSING',
  })
  @ApiServiceUnavailableResponse({ type: ErrorResponseDto, description: 'UPSTREAM_UNAVAILABLE' })
  create(
    @CurrentUser('sub') ownerId: string,
    @Body() dto: CreateWithdrawalDto,
  ): Promise<WithdrawalDto> {
    return this.withdrawals.create(ownerId, dto.depositId);
  }

  @Get('mine')
  @Roles('LANDLORD')
  @ApiOperation({ summary: 'Route 3 — Lệnh rút của tôi' })
  @ApiEnvelope(WithdrawalDto, { isArray: true })
  mine(
    @CurrentUser('sub') ownerId: string,
    @Query() query: PageQueryDto,
  ): Promise<Paginated<WithdrawalDto>> {
    return this.queries.myWithdrawals(ownerId, query);
  }
}
