import { Controller, Get, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentUser } from '../../common/auth/current-user.decorator';
import { PageQueryDto } from '../../common/response/page-query.dto';
import { ApiEnvelope } from '../../common/response/api-envelope.decorator';
import type { Paginated } from '../../common/response/response-meta';
import { WalletTransactionDto } from '../dto/payout.dto';
import { PayoutQueryService } from '../services/payout-query.service';

/** Route 1 (`RE.PAYOUT/API_Spec.md §1.4`): mọi người dùng đã đăng nhập, chỉ thấy giao dịch của mình (BR-19). */
@ApiTags('payments')
@ApiBearerAuth()
@Controller('payments/transactions')
export class TransactionsController {
  constructor(private readonly queries: PayoutQueryService) {}

  @Get('mine')
  @ApiOperation({ summary: 'Route 1 — Giao dịch ví liên quan tới tôi (người thuê hoặc chủ trọ)' })
  @ApiEnvelope(WalletTransactionDto, { isArray: true })
  mine(
    @CurrentUser('sub') userId: string,
    @Query() query: PageQueryDto,
  ): Promise<Paginated<WalletTransactionDto>> {
    return this.queries.myTransactions(userId, query);
  }
}
