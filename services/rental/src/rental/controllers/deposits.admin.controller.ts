import { Controller, Get, HttpCode, Param, Post, Query } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiConflictResponse,
  ApiNotFoundResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import type { AuthUser } from '../../common/auth/authenticated-user';
import { CurrentUser } from '../../common/auth/current-user.decorator';
import { Roles } from '../../common/auth/roles.decorator';
import { ErrorResponseDto } from '../../common/errors/error-response.dto';
import { createUuidParamPipe } from '../../common/errors/uuid-param.pipe';
import { ApiEnvelope } from '../../common/response/api-envelope.decorator';
import type { Paginated } from '../../common/response/response-meta';
import { DepositDto, ListDepositsQuery } from '../dto/deposit.dto';
import { DepositLifecycleService } from '../services/deposit-lifecycle.service';
import { DepositQueryService } from '../services/deposit-query.service';

/** Quản trị viên: /api/v1/admin/deposits (`RE.DEPOSIT_LIFECYCLE/API_Spec.md §1` route 5, 6). */
@ApiTags('admin-deposits')
@ApiBearerAuth()
@Roles('ADMIN')
@Controller('admin/deposits')
export class DepositsAdminController {
  constructor(
    private readonly queries: DepositQueryService,
    private readonly lifecycle: DepositLifecycleService,
  ) {}

  @Get()
  @ApiOperation({ summary: 'Route 5 — Danh sách đơn (mặc định PAID chưa bàn giao)' })
  @ApiEnvelope(DepositDto, { isArray: true })
  list(
    @CurrentUser() admin: AuthUser,
    @Query() query: ListDepositsQuery,
  ): Promise<Paginated<DepositDto>> {
    return this.queries.adminList(admin, query);
  }

  @Post(':id/hand-over')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Route 6 — Bàn giao đơn cho chủ trọ (BR-11): mốc admin_confirmed_at + audit_log',
  })
  @ApiEnvelope(DepositDto)
  @ApiNotFoundResponse({ type: ErrorResponseDto, description: 'RENTAL_DEPOSIT_NOT_FOUND' })
  @ApiConflictResponse({
    type: ErrorResponseDto,
    description: 'RENTAL_REFUND_PENDING, RENTAL_INVALID_TRANSITION',
  })
  handOver(
    @CurrentUser() admin: AuthUser,
    @Param('id', createUuidParamPipe('id')) id: string,
  ): Promise<DepositDto> {
    return this.lifecycle.handOver(admin, id);
  }
}
