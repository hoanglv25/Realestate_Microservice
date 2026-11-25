import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { FindOptionsWhere, IsNull, Not, Repository } from 'typeorm';
import { Paginated } from '../../common/response/response-meta';
import type { Caller } from '../domain/deposit-state';
import { DepositDto, ListDepositsQuery } from '../dto/deposit.dto';
import { Deposit } from '../entities/deposit.entity';
import { depositForbidden, depositNotFound } from '../errors/rental.errors';

/**
 * Đọc đơn (`RE.DEPOSIT_LIFECYCLE/API_Spec.md §1` route 1, 2, 5; chốt T3.5 B1–B3). Mỗi route 1 (chi tiết) hoặc 2
 * (`findAndCount`) truy vấn.
 */
@Injectable()
export class DepositQueryService {
  constructor(@InjectRepository(Deposit) private readonly deposits: Repository<Deposit>) {}

  /**
   * Route 1. Người thuê: đơn của mình. Chủ trọ: đơn đã xác nhận (BR-11) hoặc đơn `REFUNDED` của tin mình (phần còn
   * lại, BR-15 sửa) — đơn mới bàn giao chưa xác nhận KHÔNG có trong danh sách (test 12). `ix_deposits_tenant`,
   * `ix_deposits_owner`.
   */
  async findMine(caller: Caller, query: ListDepositsQuery): Promise<Paginated<DepositDto>> {
    const status = query.status ? { status: query.status } : {};
    let where: FindOptionsWhere<Deposit> | FindOptionsWhere<Deposit>[];
    if (caller.roles.includes('LANDLORD')) {
      where = [{ ownerId: caller.sub, sellerAcknowledgedAt: Not(IsNull()), ...status }];
      if (!query.status || query.status === 'REFUNDED') {
        where.push({ ownerId: caller.sub, status: 'REFUNDED' });
      }
    } else {
      where = { tenantId: caller.sub, ...status };
    }
    return this.page(caller, where, query);
  }

  /** Route 2 (BR-19, chốt T3.5 B2). Thứ tự: `404` → `403`. */
  async findOne(caller: Caller, id: string): Promise<DepositDto> {
    const d = await this.deposits.findOneBy({ id });
    if (!d) throw depositNotFound();
    if (!canView(d, caller)) throw depositForbidden();
    return DepositDto.from(d, caller, new Date());
  }

  /** Route 5. Không truyền `status` → `PAID` chưa bàn giao (việc chờ quản trị viên). `ix_deposits_status_created`. */
  adminList(caller: Caller, query: ListDepositsQuery): Promise<Paginated<DepositDto>> {
    const where: FindOptionsWhere<Deposit> = query.status
      ? { status: query.status }
      : { status: 'PAID', adminConfirmedAt: IsNull() };
    return this.page(caller, where, query);
  }

  private async page(
    caller: Caller,
    where: FindOptionsWhere<Deposit> | FindOptionsWhere<Deposit>[],
    query: ListDepositsQuery,
  ): Promise<Paginated<DepositDto>> {
    const [rows, total] = await this.deposits.findAndCount({
      where,
      order: { createdAt: 'DESC', id: 'DESC' },
      skip: query.skip,
      take: query.pageSize,
    });
    const now = new Date();
    return new Paginated(
      rows.map((d) => DepositDto.from(d, caller, now)),
      query.page,
      query.pageSize,
      total,
    );
  }
}

/**
 * Ai xem được đơn (BR-19, chốt T3.5 B2): admin; người thuê chủ đơn; chủ tin khi quản trị viên đã bàn giao (để xác
 * nhận, route 7) hoặc đơn `REFUNDED` (rút phần còn lại).
 */
export function canView(d: Deposit, caller: Caller): boolean {
  if (caller.roles.includes('ADMIN')) return true;
  if (d.tenantId === caller.sub) return true;
  return d.ownerId === caller.sub && (d.adminConfirmedAt !== null || d.status === 'REFUNDED');
}
