import { IsNull, Not } from 'typeorm';
import type { Deposit } from '../entities/deposit.entity';
import { DepositQueryService } from './deposit-query.service';

const NOW = new Date('2026-11-25T08:00:00.000Z');
const TENANT = { sub: '11111111-1111-4111-8111-111111111111', roles: ['TENANT'] };
const OWNER = { sub: '22222222-2222-4222-8222-222222222222', roles: ['LANDLORD'] };
const ADMIN = { sub: '33333333-3333-4333-8333-333333333333', roles: ['ADMIN'] };

const deposit = (over: Partial<Deposit> = {}): Deposit =>
  ({
    id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
    listingId: 'llllllll-llll-4lll-8lll-llllllllllll',
    listingTitle: 'Phòng trọ',
    tenantId: TENANT.sub,
    ownerId: OWNER.sub,
    amountVnd: 3_000_000,
    status: 'PAID',
    checkoutUrl: 'https://pay.payos.vn/web/x',
    qrCode: '000201',
    expiresAt: new Date(NOW.getTime() - 3600_000),
    paidAt: NOW,
    refundDeadlineAt: new Date(NOW.getTime() + 3600_000),
    autoReleaseAt: new Date(NOW.getTime() + 7200_000),
    adminConfirmedAt: null,
    adminConfirmedBy: null,
    sellerAcknowledgedAt: null,
    releasedAt: null,
    releaseTrigger: null,
    refundedAt: null,
    withdrawnAt: null,
    createdAt: NOW,
    ...over,
  }) as Deposit;

function setup(found: Deposit | null = deposit()) {
  const repo = {
    findOneBy: jest.fn().mockResolvedValue(found),
    findAndCount: jest.fn().mockResolvedValue([found ? [found] : [], found ? 1 : 0]),
  };
  const service = new DepositQueryService(repo as never);
  return { service, repo };
}
const page = (status?: string) =>
  Object.assign(
    Object.create({
      get skip() {
        return 0;
      },
    }),
    { page: 1, pageSize: 20, status },
  );

beforeAll(() => jest.useFakeTimers({ now: NOW, doNotFake: ['nextTick', 'setImmediate'] }));
afterAll(() => jest.useRealTimers());

describe('DepositQueryService (RE.DEPOSIT_LIFECYCLE route 1, 2, 5)', () => {
  describe('route 1 GET /deposits/mine', () => {
    it('người thuê: đơn của mình, mới nhất trước, phân trang; kèm allowedActions', async () => {
      const { service, repo } = setup();
      const res = await service.findMine(TENANT, page());
      expect(repo.findAndCount).toHaveBeenCalledWith({
        where: { tenantId: TENANT.sub },
        order: { createdAt: 'DESC', id: 'DESC' },
        skip: 0,
        take: 20,
      });
      expect(res.total).toBe(1);
      expect(res.items[0].allowedActions).toEqual(['CONFIRM_MOVE_IN', 'REQUEST_REFUND']);
    });

    it('người thuê lọc status', async () => {
      const { service, repo } = setup();
      await service.findMine(TENANT, page('RELEASED'));
      expect(repo.findAndCount.mock.calls[0][0].where).toEqual({
        tenantId: TENANT.sub,
        status: 'RELEASED',
      });
    });

    it('test 12, 14b (BR-11, BR-15): chủ trọ chỉ thấy đơn ĐÃ XÁC NHẬN hoặc đơn REFUNDED của tin mình', async () => {
      const { service, repo } = setup();
      await service.findMine(OWNER, page());
      expect(repo.findAndCount.mock.calls[0][0].where).toEqual([
        { ownerId: OWNER.sub, sellerAcknowledgedAt: Not(IsNull()) },
        { ownerId: OWNER.sub, status: 'REFUNDED' },
      ]);
    });

    it('chủ trọ lọc status: áp cho cả hai nhánh; lọc trạng thái khác REFUNDED thì nhánh REFUNDED không khớp', async () => {
      const { service, repo } = setup();
      await service.findMine(OWNER, page('RELEASED'));
      expect(repo.findAndCount.mock.calls[0][0].where).toEqual([
        { ownerId: OWNER.sub, sellerAcknowledgedAt: Not(IsNull()), status: 'RELEASED' },
      ]);
      repo.findAndCount.mockClear();
      await service.findMine(OWNER, page('REFUNDED'));
      expect(repo.findAndCount.mock.calls[0][0].where).toEqual([
        { ownerId: OWNER.sub, sellerAcknowledgedAt: Not(IsNull()), status: 'REFUNDED' },
        { ownerId: OWNER.sub, status: 'REFUNDED' },
      ]);
    });

    it('link thanh toán chỉ trả cho người thuê khi đơn PENDING_PAYMENT (B1)', async () => {
      const pending = deposit({ status: 'PENDING_PAYMENT' });
      const { service } = setup(pending);
      const [mine] = (await service.findMine(TENANT, page())).items;
      expect(mine).toMatchObject({ checkoutUrl: pending.checkoutUrl, qrCode: '000201' });
      const paid = setup(deposit());
      const [p] = (await paid.service.findMine(TENANT, page())).items;
      expect(p).not.toHaveProperty('checkoutUrl');
    });
  });

  describe('route 2 GET /deposits/:id (BR-19, chốt T3.5 B2)', () => {
    it('không có đơn -> 404 RENTAL_DEPOSIT_NOT_FOUND', async () => {
      const { service } = setup(null);
      await expect(service.findOne(TENANT, 'x')).rejects.toMatchObject({
        code: 'RENTAL_DEPOSIT_NOT_FOUND',
      });
    });

    it('người thuê chủ đơn xem được; admin xem được mọi đơn', async () => {
      await expect(setup().service.findOne(TENANT, 'x')).resolves.toMatchObject({ status: 'PAID' });
      await expect(setup().service.findOne(ADMIN, 'x')).resolves.toMatchObject({
        allowedActions: ['HAND_OVER'],
      });
    });

    it('test 16: người thuê A xem đơn của người thuê B -> 403', async () => {
      const { service } = setup();
      await expect(
        service.findOne({ sub: '44444444-4444-4444-8444-444444444444', roles: ['TENANT'] }, 'x'),
      ).rejects.toMatchObject({ code: 'FORBIDDEN', status: 403 });
    });

    it('chủ tin: chưa bàn giao -> 403; đã bàn giao (chưa xác nhận) -> xem được, có ACKNOWLEDGE; REFUNDED -> xem được', async () => {
      await expect(setup().service.findOne(OWNER, 'x')).rejects.toMatchObject({ status: 403 });
      await expect(
        setup(deposit({ adminConfirmedAt: NOW })).service.findOne(OWNER, 'x'),
      ).resolves.toMatchObject({ allowedActions: ['ACKNOWLEDGE'] });
      await expect(
        setup(deposit({ status: 'REFUNDED' })).service.findOne(OWNER, 'x'),
      ).resolves.toMatchObject({ status: 'REFUNDED' });
    });

    it('chủ trọ KHÁC -> 403 dù đơn đã bàn giao', async () => {
      const { service } = setup(deposit({ adminConfirmedAt: NOW }));
      await expect(
        service.findOne({ sub: '55555555-5555-4555-8555-555555555555', roles: ['LANDLORD'] }, 'x'),
      ).rejects.toMatchObject({ status: 403 });
    });
  });

  describe('route 5 GET /admin/deposits (chốt T3.5 B3)', () => {
    it('không truyền status -> PAID chưa bàn giao', async () => {
      const { service, repo } = setup();
      await service.adminList(ADMIN, page());
      expect(repo.findAndCount).toHaveBeenCalledWith({
        where: { status: 'PAID', adminConfirmedAt: IsNull() },
        order: { createdAt: 'DESC', id: 'DESC' },
        skip: 0,
        take: 20,
      });
    });

    it('có status -> mọi đơn trạng thái đó', async () => {
      const { service, repo } = setup();
      await service.adminList(ADMIN, page('REFUND_REQUESTED'));
      expect(repo.findAndCount.mock.calls[0][0].where).toEqual({ status: 'REFUND_REQUESTED' });
    });
  });
});
