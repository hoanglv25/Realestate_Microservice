import { HttpStatus } from '@nestjs/common';
import { In, IsNull, MoreThanOrEqual } from 'typeorm';
import { AppException } from '../../common/errors/app.exception';
import { AuditLog } from '../entities/audit-log.entity';
import { Deposit } from '../entities/deposit.entity';
import { DepositLifecycleService } from './deposit-lifecycle.service';

const NOW = new Date('2026-11-25T08:00:00.000Z');
const TENANT = { sub: '11111111-1111-4111-8111-111111111111', roles: ['TENANT'] };
const OWNER = { sub: '22222222-2222-4222-8222-222222222222', roles: ['LANDLORD'] };
const ADMIN = { sub: '33333333-3333-4333-8333-333333333333', roles: ['ADMIN'] };
const ID = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const LISTING = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';

const deposit = (over: Partial<Deposit> = {}): Deposit =>
  ({
    id: ID,
    listingId: LISTING,
    listingTitle: 'Phòng trọ',
    tenantId: TENANT.sub,
    ownerId: OWNER.sub,
    amountVnd: 3_000_000,
    status: 'PAID',
    checkoutUrl: null,
    qrCode: null,
    expiresAt: new Date(NOW.getTime() - 3600_000),
    paidAt: new Date(NOW.getTime() - 3600_000),
    refundDeadlineAt: new Date(NOW.getTime() + 3600_000),
    autoReleaseAt: new Date(NOW.getTime() + 7200_000),
    adminConfirmedAt: null,
    adminConfirmedBy: null,
    sellerAcknowledgedAt: null,
    releasedAt: null,
    releaseTrigger: null,
    refundedAt: null,
    withdrawnAt: null,
    refundSyncedAt: null,
    createdAt: new Date(NOW.getTime() - 7200_000),
    ...over,
  }) as Deposit;

function setup(found: Deposit | null = deposit()) {
  const calls: string[] = [];
  const repo = {
    findOneBy: jest.fn().mockResolvedValue(found),
    update: jest.fn(async () => {
      calls.push('repo.update');
      return { affected: 1 };
    }),
  };
  const m = {
    update: jest.fn(async () => {
      calls.push('tx.update');
      return { affected: 1 };
    }),
    insert: jest.fn().mockResolvedValue({}),
    findOneBy: jest.fn().mockResolvedValue(found),
  };
  const dataSource = {
    transaction: jest.fn(async (cb: (mm: typeof m) => Promise<unknown>) => {
      calls.push('transaction');
      return cb(m);
    }),
  };
  const payment = {
    createRefund: jest.fn(async () => {
      calls.push('createRefund');
      return { refundRequestId: 'r1' };
    }),
  };
  const outbox = { add: jest.fn().mockResolvedValue(undefined) };
  const sync = {
    push: jest.fn(async () => {
      calls.push('push');
      return 'SYNCED';
    }),
  };
  const logger = { warn: jest.fn(), log: jest.fn() };
  const service = new DepositLifecycleService(
    repo as never,
    dataSource as never,
    payment as never,
    outbox as never,
    sync as never,
  );
  (service as unknown as { logger: typeof logger }).logger = logger;
  return { service, calls, repo, m, dataSource, payment, outbox, sync, logger };
}

beforeAll(() => jest.useFakeTimers({ now: NOW, doNotFake: ['nextTick', 'setImmediate'] }));
afterAll(() => jest.useRealTimers());

const NOT_PAID = [
  'PENDING_PAYMENT',
  'REFUND_REQUESTED',
  'RELEASED',
  'REFUNDED',
  'WITHDRAWN',
  'EXPIRED',
] as const;

describe('DepositLifecycleService (RE.DEPOSIT_LIFECYCLE)', () => {
  describe('route 3 confirm-move-in (BR-13)', () => {
    it('test 9: PAID -> RELEASED trigger TENANT, đích RENTED, outbox deposit-released; đẩy RENTED SAU commit', async () => {
      const { service, calls, m, outbox, sync } = setup();
      const res = await service.confirmMoveIn(TENANT, ID);

      expect(m.update).toHaveBeenCalledWith(
        Deposit,
        { id: ID, status: 'PAID' },
        {
          status: 'RELEASED',
          releasedAt: NOW,
          releaseTrigger: 'TENANT',
          listingTargetStatus: 'RENTED',
          listingSyncedAt: null,
        },
      );
      expect(outbox.add).toHaveBeenCalledWith(m, 'rental.deposit-released', {
        depositId: ID,
        listingId: LISTING,
        tenantId: TENANT.sub,
        ownerId: OWNER.sub,
        trigger: 'TENANT',
      });
      expect(calls).toEqual(['transaction', 'tx.update', 'push']);
      expect(sync.push).toHaveBeenCalledWith({
        id: ID,
        listingId: LISTING,
        listingTargetStatus: 'RENTED',
      });
      expect(res).toMatchObject({
        status: 'RELEASED',
        releaseTrigger: 'TENANT',
        allowedActions: [],
      });
    });

    it('đẩy listing lỗi -> vẫn 200 RELEASED (job (b) đẩy lại)', async () => {
      const { service, sync, logger } = setup();
      sync.push.mockRejectedValueOnce(new Error('db'));
      await expect(service.confirmMoveIn(TENANT, ID)).resolves.toMatchObject({
        status: 'RELEASED',
      });
      expect(logger.warn).toHaveBeenCalled();
    });

    it('thứ tự kiểm tra: 404 -> 403 (người thuê khác, chủ trọ) -> 409', async () => {
      await expect(setup(null).service.confirmMoveIn(TENANT, ID)).rejects.toMatchObject({
        code: 'RENTAL_DEPOSIT_NOT_FOUND',
      });
      await expect(
        setup().service.confirmMoveIn({ sub: 'other', roles: ['TENANT'] }, ID),
      ).rejects.toMatchObject({ status: 403 });
      await expect(
        setup(deposit({ status: 'RELEASED' })).service.confirmMoveIn(
          { sub: 'other', roles: ['TENANT'] },
          ID,
        ),
      ).rejects.toMatchObject({ status: 403 });
    });

    it.each(NOT_PAID)('đơn %s -> 409 RENTAL_INVALID_TRANSITION, không ghi gì', async (status) => {
      const { service, dataSource } = setup(deposit({ status }));
      await expect(service.confirmMoveIn(TENANT, ID)).rejects.toMatchObject({
        code: 'RENTAL_INVALID_TRANSITION',
        status: 409,
      });
      expect(dataSource.transaction).not.toHaveBeenCalled();
    });

    it('UPDATE 0 dòng (AutoReleaseJob hoặc yêu cầu hoàn thắng trước) -> 409, không outbox, không đẩy', async () => {
      const { service, m, outbox, sync } = setup();
      m.update.mockResolvedValueOnce({ affected: 0 });
      await expect(service.confirmMoveIn(TENANT, ID)).rejects.toMatchObject({ status: 409 });
      expect(outbox.add).not.toHaveBeenCalled();
      expect(sync.push).not.toHaveBeenCalled();
    });
  });

  describe('route 4 refund-request (BR-12)', () => {
    it('test 2: trong 48 giờ -> REFUND_REQUESTED (UPDATE có điều kiện thời hạn), GỌI payment MỘT lần SAU khi thắng, đánh dấu refund_synced_at', async () => {
      const { service, calls, repo, payment } = setup();
      const res = await service.requestRefund(TENANT, ID);

      expect(repo.update).toHaveBeenNthCalledWith(
        1,
        { id: ID, status: 'PAID', refundDeadlineAt: MoreThanOrEqual(NOW) },
        { status: 'REFUND_REQUESTED', refundSyncedAt: null },
      );
      expect(payment.createRefund).toHaveBeenCalledTimes(1);
      expect(payment.createRefund).toHaveBeenCalledWith({ depositId: ID });
      expect(repo.update).toHaveBeenNthCalledWith(
        2,
        { id: ID, refundSyncedAt: IsNull() },
        { refundSyncedAt: NOW },
      );
      expect(calls).toEqual(['repo.update', 'createRefund', 'repo.update']);
      expect(res).toMatchObject({ status: 'REFUND_REQUESTED', allowedActions: [] });
    });

    it('đúng mốc hạn (now = refund_deadline_at) vẫn được', async () => {
      const { service } = setup(deposit({ refundDeadlineAt: NOW }));
      await expect(service.requestRefund(TENANT, ID)).resolves.toMatchObject({
        status: 'REFUND_REQUESTED',
      });
    });

    it('test 3: sau 48 giờ -> 409 RENTAL_REFUND_WINDOW_CLOSED; sau RELEASED -> 409 RENTAL_INVALID_TRANSITION; đơn không đổi, không gọi payment', async () => {
      const late = setup(deposit({ refundDeadlineAt: new Date(NOW.getTime() - 1) }));
      await expect(late.service.requestRefund(TENANT, ID)).rejects.toMatchObject({
        code: 'RENTAL_REFUND_WINDOW_CLOSED',
        status: 409,
      });
      expect(late.repo.update).not.toHaveBeenCalled();
      expect(late.payment.createRefund).not.toHaveBeenCalled();

      const released = setup(deposit({ status: 'RELEASED' }));
      await expect(released.service.requestRefund(TENANT, ID)).rejects.toMatchObject({
        code: 'RENTAL_INVALID_TRANSITION',
      });
      expect(released.repo.update).not.toHaveBeenCalled();
    });

    it('đơn đã REFUND_REQUESTED -> 409 RENTAL_INVALID_TRANSITION (Báo cáo T11)', async () => {
      const { service } = setup(deposit({ status: 'REFUND_REQUESTED' }));
      await expect(service.requestRefund(TENANT, ID)).rejects.toMatchObject({
        code: 'RENTAL_INVALID_TRANSITION',
      });
    });

    it('test 4: payment lỗi (kể cả 4xx) -> vẫn 200 REFUND_REQUESTED, KHÔNG đánh dấu (job (c) gửi lại), log warn', async () => {
      for (const err of [
        new AppException('UPSTREAM_UNAVAILABLE', 'x', HttpStatus.SERVICE_UNAVAILABLE),
        new AppException('NOT_FOUND', 'x', HttpStatus.NOT_FOUND),
      ]) {
        const { service, repo, payment, logger } = setup();
        payment.createRefund.mockRejectedValueOnce(err);
        await expect(service.requestRefund(TENANT, ID)).resolves.toMatchObject({
          status: 'REFUND_REQUESTED',
        });
        expect(repo.update).toHaveBeenCalledTimes(1);
        expect(logger.warn).toHaveBeenCalled();
      }
    });

    it('UPDATE 0 dòng (AutoReleaseJob thắng, E7) -> 409, không gọi payment', async () => {
      const { service, repo, payment } = setup();
      repo.update.mockResolvedValueOnce({ affected: 0 });
      await expect(service.requestRefund(TENANT, ID)).rejects.toMatchObject({ status: 409 });
      expect(payment.createRefund).not.toHaveBeenCalled();
    });

    it('người thuê khác -> 403', async () => {
      await expect(
        setup().service.requestRefund({ sub: 'other', roles: ['TENANT'] }, ID),
      ).rejects.toMatchObject({ status: 403 });
    });
  });

  describe('route 6 hand-over (BR-11, B12)', () => {
    it('test 14a: PAID chưa bàn giao -> một transaction: đặt mốc + audit_log HAND_OVER + outbox deposit-handed-over', async () => {
      const { service, m, outbox } = setup();
      const res = await service.handOver(ADMIN, ID);

      expect(m.update).toHaveBeenCalledWith(
        Deposit,
        { id: ID, status: In(['PAID', 'RELEASED']), adminConfirmedAt: IsNull() },
        { adminConfirmedAt: NOW, adminConfirmedBy: ADMIN.sub },
      );
      expect(m.insert).toHaveBeenCalledWith(
        AuditLog,
        expect.objectContaining({
          actorId: ADMIN.sub,
          action: 'HAND_OVER',
          targetType: 'DEPOSIT',
          targetId: ID,
          before: { status: 'PAID', adminConfirmedAt: null },
          after: {
            status: 'PAID',
            adminConfirmedAt: NOW.toISOString(),
            adminConfirmedBy: ADMIN.sub,
          },
        }),
      );
      expect(outbox.add).toHaveBeenCalledWith(m, 'rental.deposit-handed-over', {
        depositId: ID,
        listingId: LISTING,
        tenantId: TENANT.sub,
        ownerId: OWNER.sub,
        adminId: ADMIN.sub,
      });
      expect(res).toMatchObject({ adminConfirmedAt: NOW.toISOString(), allowedActions: [] });
    });

    it('đơn đã RELEASED (tự giải ngân) vẫn bàn giao được: chỉ ghi mốc, giữ RELEASED', async () => {
      const { service, m } = setup(deposit({ status: 'RELEASED' }));
      await expect(service.handOver(ADMIN, ID)).resolves.toMatchObject({ status: 'RELEASED' });
      expect(m.update).toHaveBeenCalled();
    });

    it('test 14a: đã bàn giao -> 200 không đổi, không transaction, không audit_log thêm', async () => {
      const { service, dataSource } = setup(deposit({ adminConfirmedAt: NOW }));
      await expect(service.handOver(ADMIN, ID)).resolves.toMatchObject({
        adminConfirmedAt: NOW.toISOString(),
      });
      expect(dataSource.transaction).not.toHaveBeenCalled();
    });

    it('test 10: REFUND_REQUESTED -> 409 RENTAL_REFUND_PENDING', async () => {
      const { service, dataSource } = setup(deposit({ status: 'REFUND_REQUESTED' }));
      await expect(service.handOver(ADMIN, ID)).rejects.toMatchObject({
        code: 'RENTAL_REFUND_PENDING',
        status: 409,
      });
      expect(dataSource.transaction).not.toHaveBeenCalled();
    });

    it.each(['PENDING_PAYMENT', 'EXPIRED', 'CANCELLED', 'REFUNDED', 'WITHDRAWN'] as const)(
      'đơn %s -> 409 RENTAL_INVALID_TRANSITION',
      async (status) => {
        await expect(setup(deposit({ status })).service.handOver(ADMIN, ID)).rejects.toMatchObject({
          code: 'RENTAL_INVALID_TRANSITION',
        });
      },
    );

    it('UPDATE 0 dòng: admin khác vừa bàn giao -> 200 không ghi audit; người thuê vừa yêu cầu hoàn -> 409 REFUND_PENDING', async () => {
      const a = setup();
      a.m.update.mockResolvedValueOnce({ affected: 0 });
      a.m.findOneBy.mockResolvedValueOnce(deposit({ adminConfirmedAt: NOW }));
      await expect(a.service.handOver(ADMIN, ID)).resolves.toMatchObject({
        adminConfirmedAt: NOW.toISOString(),
      });
      expect(a.m.insert).not.toHaveBeenCalled();
      expect(a.outbox.add).not.toHaveBeenCalled();

      const b = setup();
      b.m.update.mockResolvedValueOnce({ affected: 0 });
      b.m.findOneBy.mockResolvedValueOnce(deposit({ status: 'REFUND_REQUESTED' }));
      await expect(b.service.handOver(ADMIN, ID)).rejects.toMatchObject({
        code: 'RENTAL_REFUND_PENDING',
      });
    });

    it('không có đơn -> 404', async () => {
      await expect(setup(null).service.handOver(ADMIN, ID)).rejects.toMatchObject({
        code: 'RENTAL_DEPOSIT_NOT_FOUND',
      });
    });
  });

  describe('route 7 acknowledge (BR-11)', () => {
    it('đã bàn giao -> đặt seller_acknowledged_at (chỉ khi còn trống)', async () => {
      const { service, repo } = setup(deposit({ adminConfirmedAt: NOW }));
      const res = await service.acknowledge(OWNER, ID);
      expect(repo.update).toHaveBeenCalledWith(
        { id: ID, sellerAcknowledgedAt: IsNull() },
        { sellerAcknowledgedAt: NOW },
      );
      expect(res).toMatchObject({ sellerAcknowledgedAt: NOW.toISOString(), allowedActions: [] });
    });

    it('test 11: chủ trọ xác nhận trước bàn giao -> 409 RENTAL_NOT_HANDED_OVER', async () => {
      const { service, repo } = setup();
      await expect(service.acknowledge(OWNER, ID)).rejects.toMatchObject({
        code: 'RENTAL_NOT_HANDED_OVER',
        status: 409,
      });
      expect(repo.update).not.toHaveBeenCalled();
    });

    it('đã xác nhận -> 200 không đổi', async () => {
      const { service, repo } = setup(
        deposit({ adminConfirmedAt: NOW, sellerAcknowledgedAt: NOW }),
      );
      await expect(service.acknowledge(OWNER, ID)).resolves.toMatchObject({
        sellerAcknowledgedAt: NOW.toISOString(),
      });
      expect(repo.update).not.toHaveBeenCalled();
    });

    it('chủ trọ khác -> 403 (trước 409)', async () => {
      await expect(
        setup().service.acknowledge({ sub: 'other', roles: ['LANDLORD'] }, ID),
      ).rejects.toMatchObject({ status: 403 });
    });
  });

  describe('withdrawal-eligibility (BR-15 sửa 2026-11-12)', () => {
    it.each([
      [{ adminConfirmedAt: NOW, sellerAcknowledgedAt: NOW }, true, []],
      [
        { adminConfirmedAt: null, sellerAcknowledgedAt: null },
        false,
        ['NOT_HANDED_OVER', 'NOT_ACKNOWLEDGED'],
      ],
      [{ adminConfirmedAt: NOW, sellerAcknowledgedAt: null }, false, ['NOT_ACKNOWLEDGED']],
    ])('test 13: RELEASED %j -> eligible %s, missing %j', async (marks, eligible, missing) => {
      const { service } = setup(deposit({ status: 'RELEASED', ...marks }));
      await expect(service.withdrawalEligibility(ID)).resolves.toEqual({
        depositId: ID,
        ownerId: OWNER.sub,
        amountVnd: 3_000_000,
        status: 'RELEASED',
        eligible,
        missing,
      });
    });

    it('test 13a: REFUNDED chưa bàn giao -> eligible, missing rỗng', async () => {
      const { service } = setup(deposit({ status: 'REFUNDED' }));
      await expect(service.withdrawalEligibility(ID)).resolves.toMatchObject({
        eligible: true,
        missing: [],
      });
    });

    it.each([
      'PAID',
      'PENDING_PAYMENT',
      'REFUND_REQUESTED',
      'WITHDRAWN',
      'EXPIRED',
      'CANCELLED',
    ] as const)('%s -> không đủ, missing NOT_RELEASED', async (status) => {
      const { service } = setup(
        deposit({ status, adminConfirmedAt: NOW, sellerAcknowledgedAt: NOW }),
      );
      await expect(service.withdrawalEligibility(ID)).resolves.toMatchObject({
        eligible: false,
        missing: ['NOT_RELEASED'],
      });
    });

    it('không có đơn -> 404 RENTAL_DEPOSIT_NOT_FOUND', async () => {
      await expect(setup(null).service.withdrawalEligibility(ID)).rejects.toMatchObject({
        code: 'RENTAL_DEPOSIT_NOT_FOUND',
      });
    });
  });
});
