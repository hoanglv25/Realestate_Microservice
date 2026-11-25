import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  Post,
  Query,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import {
  ApiBearerAuth,
  ApiBody,
  ApiConflictResponse,
  ApiConsumes,
  ApiNotFoundResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { CurrentUser } from '../../common/auth/current-user.decorator';
import { Roles } from '../../common/auth/roles.decorator';
import { ErrorResponseDto } from '../../common/errors/error-response.dto';
import { createUuidParamPipe } from '../../common/errors/uuid-param.pipe';
import { Idempotent } from '../../common/idempotency/idempotent.decorator';
import { ApiEnvelope } from '../../common/response/api-envelope.decorator';
import type { Paginated } from '../../common/response/response-meta';
import {
  AuditLogDto,
  ListAuditLogsQuery,
  ListRefundsQuery,
  ListWithdrawalsQuery,
  ReasonDto,
  RefundDetailDto,
  RefundDto,
  WalletSummaryDto,
  WithdrawalDetailDto,
  WithdrawalDto,
} from '../dto/payout.dto';
import { ReceiptTooLargeInterceptor } from '../http/receipt-too-large.interceptor';
import type { ReceiptFile } from '../services/receipt.service';
import { PayoutQueryService } from '../services/payout-query.service';
import { RefundService } from '../services/refund.service';
import { WithdrawalService } from '../services/withdrawal.service';

const idPipe = createUuidParamPipe('id');

/** Tệp chứng từ: trường multipart `receipt`. Cỡ tối đa đặt ở `MulterModule` (`RECEIPT_MAX_BYTES`). */
const RECEIPT_BODY = {
  schema: {
    type: 'object',
    required: ['receipt'],
    properties: {
      receipt: {
        type: 'string',
        format: 'binary',
        description: 'Ảnh JPEG/PNG hoặc PDF chứng từ chuyển khoản (BR-17)',
      },
    },
  },
};

/**
 * Quản trị viên xử lý lệnh chi: route 4–14 (`RE.PAYOUT/API_Spec.md §1`). Chuyển khoản ngoài hệ thống rồi hoàn tất
 * kèm chứng từ (ví chỉ bị trừ lúc này), từ chối (hoàn) hoặc đánh dấu thất bại. Mọi thao tác ghi có `audit_log`.
 */
@ApiTags('admin-payouts')
@ApiBearerAuth()
@Roles('ADMIN')
@Controller('admin')
export class PayoutsAdminController {
  constructor(
    private readonly withdrawals: WithdrawalService,
    private readonly refunds: RefundService,
    private readonly queries: PayoutQueryService,
  ) {}

  // ---------- Lệnh rút ----------

  @Get('withdrawals')
  @ApiOperation({ summary: 'Route 4 — Lệnh rút (lọc status)' })
  @ApiEnvelope(WithdrawalDto, { isArray: true })
  listWithdrawals(@Query() query: ListWithdrawalsQuery): Promise<Paginated<WithdrawalDto>> {
    return this.queries.adminWithdrawals(query);
  }

  @Get('withdrawals/:id')
  @ApiOperation({
    summary: 'Route 13 — Chi tiết lệnh rút kèm số tài khoản đầy đủ (lấy từ identity lúc xem)',
  })
  @ApiEnvelope(WithdrawalDetailDto)
  @ApiNotFoundResponse({ type: ErrorResponseDto, description: 'PAYMENT_PAYOUT_NOT_FOUND' })
  withdrawalDetail(@Param('id', idPipe) id: string): Promise<WithdrawalDetailDto> {
    return this.queries.withdrawalDetail(id);
  }

  @Post('withdrawals/:id/complete')
  @HttpCode(200)
  @Idempotent()
  @UseInterceptors(ReceiptTooLargeInterceptor, FileInterceptor('receipt'))
  @ApiConsumes('multipart/form-data')
  @ApiBody(RECEIPT_BODY)
  @ApiOperation({ summary: 'Route 6 — Hoàn tất lệnh rút kèm chứng từ: WITHDRAW_OUT' })
  @ApiEnvelope(WithdrawalDto)
  @ApiConflictResponse({
    type: ErrorResponseDto,
    description:
      'PAYMENT_PAYOUT_INVALID_STATUS, PAYMENT_RECEIPT_ALREADY_USED, PAYMENT_WALLET_INSUFFICIENT',
  })
  completeWithdrawal(
    @CurrentUser('sub') adminId: string,
    @Param('id', idPipe) id: string,
    @UploadedFile() file: ReceiptFile | undefined,
  ): Promise<WithdrawalDto> {
    return this.withdrawals.complete(adminId, id, file);
  }

  @Post('withdrawals/:id/fail')
  @HttpCode(200)
  @ApiOperation({ summary: 'Route 7 — Lệnh rút thất bại (ví không đổi)' })
  @ApiEnvelope(WithdrawalDto)
  failWithdrawal(
    @CurrentUser('sub') adminId: string,
    @Param('id', idPipe) id: string,
    @Body() dto: ReasonDto,
  ): Promise<WithdrawalDto> {
    return this.withdrawals.fail(adminId, id, dto.reason);
  }

  // ---------- Yêu cầu hoàn ----------

  @Get('refund-requests')
  @ApiOperation({ summary: 'Route 5 — Yêu cầu hoàn (lọc status)' })
  @ApiEnvelope(RefundDto, { isArray: true })
  listRefunds(@Query() query: ListRefundsQuery): Promise<Paginated<RefundDto>> {
    return this.queries.adminRefunds(query);
  }

  @Get('refund-requests/:id')
  @ApiOperation({
    summary: 'Route 14 — Chi tiết yêu cầu hoàn kèm số tài khoản của người thuê (null: chưa khai)',
  })
  @ApiEnvelope(RefundDetailDto)
  @ApiNotFoundResponse({ type: ErrorResponseDto, description: 'PAYMENT_PAYOUT_NOT_FOUND' })
  refundDetail(@Param('id', idPipe) id: string): Promise<RefundDetailDto> {
    return this.queries.refundDetail(id);
  }

  @Post('refund-requests/:id/complete')
  @HttpCode(200)
  @Idempotent()
  @UseInterceptors(ReceiptTooLargeInterceptor, FileInterceptor('receipt'))
  @ApiConsumes('multipart/form-data')
  @ApiBody(RECEIPT_BODY)
  @ApiOperation({ summary: 'Route 8 — Hoàn tất yêu cầu hoàn kèm chứng từ: REFUND_OUT' })
  @ApiEnvelope(RefundDto)
  @ApiConflictResponse({
    type: ErrorResponseDto,
    description:
      'PAYMENT_PAYOUT_INVALID_STATUS, PAYMENT_RECEIPT_ALREADY_USED, PAYMENT_WALLET_INSUFFICIENT',
  })
  completeRefund(
    @CurrentUser('sub') adminId: string,
    @Param('id', idPipe) id: string,
    @UploadedFile() file: ReceiptFile | undefined,
  ): Promise<RefundDto> {
    return this.refunds.complete(adminId, id, file);
  }

  @Post('refund-requests/:id/reject')
  @HttpCode(200)
  @ApiOperation({ summary: 'Route 9 — Từ chối hoàn (đơn về PAID)' })
  @ApiEnvelope(RefundDto)
  rejectRefund(
    @CurrentUser('sub') adminId: string,
    @Param('id', idPipe) id: string,
    @Body() dto: ReasonDto,
  ): Promise<RefundDto> {
    return this.refunds.reject(adminId, id, dto.reason);
  }

  @Post('refund-requests/:id/fail')
  @HttpCode(200)
  @ApiOperation({ summary: 'Route 10 — Hoàn thất bại (làm lại sau, không phát sự kiện)' })
  @ApiEnvelope(RefundDto)
  failRefund(
    @CurrentUser('sub') adminId: string,
    @Param('id', idPipe) id: string,
    @Body() dto: ReasonDto,
  ): Promise<RefundDto> {
    return this.refunds.fail(adminId, id, dto.reason);
  }

  // ---------- Ví, nhật ký ----------

  @Get('wallet')
  @ApiOperation({ summary: 'Route 11 — Số dư ví trung gian, tổng đang chờ chi' })
  @ApiEnvelope(WalletSummaryDto)
  wallet(): Promise<WalletSummaryDto> {
    return this.queries.wallet();
  }

  @Get('audit-logs')
  @ApiOperation({ summary: 'Route 12 — Nhật ký thao tác quản trị' })
  @ApiEnvelope(AuditLogDto, { isArray: true })
  auditLogs(@Query() query: ListAuditLogsQuery): Promise<Paginated<AuditLogDto>> {
    return this.queries.auditLogs(query);
  }
}
