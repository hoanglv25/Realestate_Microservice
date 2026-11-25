import { Injectable } from '@nestjs/common';
import type { EntityManager } from 'typeorm';
import { getCorrelationId } from '../../common/logging/correlation-id.middleware';
import type { AuditAction, AuditTargetType } from '../entities/audit-log.entity';

export interface AuditInput {
  actorId: string;
  action: AuditAction;
  targetType: AuditTargetType;
  targetId: string;
  /** Trạng thái trước, sau thao tác (`{ status, … }`). Không chứa số tài khoản đầy đủ. */
  before: Record<string, unknown>;
  after: Record<string, unknown>;
}

const INSERT_AUDIT = `
  INSERT INTO audit_log (actor_id, action, target_type, target_id, before, after, correlation_id)
  VALUES ($1, $2, $3, $4, $5, $6, $7)`;

/**
 * Nhật ký thao tác quản trị trên lệnh chi (`RE.PAYOUT/API_Spec.md §1.3`, test 14). Luôn ghi trong transaction của
 * thao tác: thao tác rollback thì không có dòng nhật ký. Một truy vấn. Bản riêng của payment (rental có bản của
 * nó cho bàn giao, T3.5): không import chéo service.
 */
@Injectable()
export class AuditService {
  async log(m: EntityManager, input: AuditInput): Promise<void> {
    await m.query(INSERT_AUDIT, [
      input.actorId,
      input.action,
      input.targetType,
      input.targetId,
      JSON.stringify(input.before),
      JSON.stringify(input.after),
      getCorrelationId() ?? null,
    ]);
  }
}
