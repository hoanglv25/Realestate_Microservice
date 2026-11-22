import { Body, Controller, Get, HttpCode, Param, Post, Query } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiConflictResponse,
  ApiForbiddenResponse,
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
import {
  CreateViewingDto,
  ListViewingsQuery,
  RespondViewingDto,
  ViewingDto,
} from '../dto/viewing.dto';
import { ViewingService } from '../services/viewing.service';

const idPipe = createUuidParamPipe('id');

/** Lịch xem nhà: /api/v1/viewings (`RE.VIEWING/API_Spec.md §1`, route 1–5). Người gọi luôn là `sub` của JWT. */
@ApiTags('viewings')
@ApiBearerAuth()
@Controller('viewings')
export class ViewingsController {
  constructor(private readonly viewings: ViewingService) {}

  @Post()
  @Roles('TENANT')
  @ApiOperation({ summary: 'Đặt lịch xem (không chọn giờ; hai bên hẹn qua chat)' })
  @ApiEnvelope(ViewingDto, { status: 201 })
  @ApiNotFoundResponse({ type: ErrorResponseDto, description: 'LISTING_NOT_FOUND' })
  @ApiForbiddenResponse({ type: ErrorResponseDto, description: 'RENTAL_VIEWING_OWN_LISTING' })
  @ApiConflictResponse({ type: ErrorResponseDto, description: 'RENTAL_VIEWING_DUPLICATE' })
  request(
    @CurrentUser('sub') tenantId: string,
    @Body() dto: CreateViewingDto,
  ): Promise<ViewingDto> {
    return this.viewings.request(tenantId, dto);
  }

  @Get('mine')
  @Roles('TENANT', 'LANDLORD')
  @ApiOperation({ summary: 'Lịch xem của tôi (người thuê: tôi gửi; chủ trọ: trên tin của tôi)' })
  @ApiEnvelope(ViewingDto, { isArray: true })
  findMine(
    @CurrentUser() user: AuthUser,
    @Query() query: ListViewingsQuery,
  ): Promise<Paginated<ViewingDto>> {
    return this.viewings.findMine(user, query);
  }

  @Post(':id/respond')
  @HttpCode(200)
  @Roles('LANDLORD')
  @ApiOperation({ summary: 'Chủ tin từ chối yêu cầu xem (decision = DECLINE)' })
  @ApiEnvelope(ViewingDto)
  @ApiConflictResponse({ type: ErrorResponseDto, description: 'RENTAL_INVALID_TRANSITION' })
  respond(
    @CurrentUser('sub') ownerId: string,
    @Param('id', idPipe) id: string,
    @Body() _dto: RespondViewingDto,
  ): Promise<ViewingDto> {
    return this.viewings.decline(ownerId, id);
  }

  @Post(':id/confirm-viewed')
  @HttpCode(200)
  @Roles('TENANT')
  @ApiOperation({ summary: 'Người đặt xác nhận đã xem' })
  @ApiEnvelope(ViewingDto)
  confirmViewed(
    @CurrentUser('sub') tenantId: string,
    @Param('id', idPipe) id: string,
  ): Promise<ViewingDto> {
    return this.viewings.confirmViewed(tenantId, id);
  }

  @Post(':id/cancel')
  @HttpCode(200)
  @Roles('TENANT')
  @ApiOperation({ summary: 'Người đặt tự hủy yêu cầu đang mở' })
  @ApiEnvelope(ViewingDto)
  cancel(
    @CurrentUser('sub') tenantId: string,
    @Param('id', idPipe) id: string,
  ): Promise<ViewingDto> {
    return this.viewings.cancelByTenant(tenantId, id);
  }
}
