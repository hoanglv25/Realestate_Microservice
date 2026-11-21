import { QueryFailedError } from 'typeorm';
import { AppException } from '../../common/errors/app.exception';
import { RentalError } from '../errors/rental.errors';
import type { Viewing } from '../entities/viewing.entity';
import { ViewingService } from './viewing.service';

const TENANT = '11111111-1111-4111-8111-111111111111';
const OWNER = '22222222-2222-4222-8222-222222222222';
const LISTING = '33333333-3333-4333-8333-333333333333';
const VIEWING = '44444444-4444-4444-8444-444444444444';
const SNAPSHOT = {
  id: LISTING,
  ownerId: OWNER,
  title: 'Phòng 25m2',
  depositAmountVnd: 3_000_000,
  status: 'AVAILABLE',
  approvalStatus: 'APPROVED',
};
const row = (over: Partial<Record<string, unknown>> = {}) => ({
  id: VIEWING,
  listing_id: LISTING,
  tenant_id: TENANT,
  owner_id: OWNER,
  listing_title: 'Phòng 25m2',
  status: 'REQUESTED',
  cancel_reason: null,
  note: null,
  created_at: new Date('2026-11-21T08:00:00Z'),
  ...over,
});

function setup() {
  const outbox = { add: jest.fn().mockResolvedValue({}) };
  const manager = {
    query: jest.fn(),
    findOneBy: jest.fn(),
  };
  const dataSource = { transaction: jest.fn(async (cb: (m: unknown) => unknown) => cb(manager)) };
  const listing = { getSnapshot: jest.fn().mockResolvedValue(SNAPSHOT) };
  const viewings = { findAndCount: jest.fn().mockResolvedValue([[], 0]) };
  const service = new ViewingService(
    dataSource as never,
    viewings as never,
    listing as never,
    outbox as never,
  );
  return { service, outbox, manager, listing, viewings };
}

const codeOf = (p: Promise<unknown>) =>
  p.then(
    () => 'khong-loi',
    (e: { code?: string }) => e.code,
  );

describe('ViewingService.request (route 1)', () => {
  it('tạo REQUESTED với bản chụp chủ tin, tiêu đề; ghi rental.viewing-requested cùng transaction', async () => {
    const { service, manager, outbox } = setup();
    manager.query.mockResolvedValueOnce([row({ note: 'cuối tuần' })]);
    const v = await service.request(TENANT, { listingId: LISTING, note: 'cuối tuần' });

    const [sql, params] = manager.query.mock.calls[0];
    expect(sql).toMatch(/INSERT INTO viewings/);
    expect(params).toEqual([LISTING, TENANT, OWNER, 'Phòng 25m2', 'cuối tuần']);
    expect(outbox.add).toHaveBeenCalledWith(manager, 'rental.viewing-requested', {
      viewingId: VIEWING,
      listingId: LISTING,
      tenantId: TENANT,
      ownerId: OWNER,
    });
    expect(v).toMatchObject({ id: VIEWING, status: 'REQUESTED', note: 'cuối tuần' });
  });

  it('test 1: tin chưa duyệt -> 404 LISTING_NOT_FOUND; listing 404 chuyển nguyên', async () => {
    const { service, listing, manager } = setup();
    listing.getSnapshot.mockResolvedValueOnce({ ...SNAPSHOT, approvalStatus: 'PENDING_REVIEW' });
    expect(await codeOf(service.request(TENANT, { listingId: LISTING }))).toBe(
      RentalError.LISTING_NOT_FOUND,
    );
    listing.getSnapshot.mockRejectedValueOnce(new AppException('LISTING_NOT_FOUND', 'x', 404));
    expect(await codeOf(service.request(TENANT, { listingId: LISTING }))).toBe('LISTING_NOT_FOUND');
    expect(manager.query).not.toHaveBeenCalled();
  });

  it('chủ tin tự đặt -> 403 RENTAL_VIEWING_OWN_LISTING', async () => {
    const { service } = setup();
    expect(await codeOf(service.request(OWNER, { listingId: LISTING }))).toBe(
      RentalError.VIEWING_OWN_LISTING,
    );
  });

  it('test 2: trùng ux_viewings_open_per_tenant -> 409 RENTAL_VIEWING_DUPLICATE, không ghi outbox', async () => {
    const { service, manager, outbox } = setup();
    manager.query.mockRejectedValueOnce(
      new QueryFailedError(
        'INSERT',
        [],
        Object.assign(new Error('dup'), {
          code: '23505',
          constraint: 'ux_viewings_open_per_tenant',
        }),
      ),
    );
    expect(await codeOf(service.request(TENANT, { listingId: LISTING }))).toBe(
      RentalError.VIEWING_DUPLICATE,
    );
    expect(outbox.add).not.toHaveBeenCalled();
  });
});

describe('ViewingService: chuyển trạng thái (route 2, 3, 5)', () => {
  it('decline: UPDATE ... WHERE status=REQUESTED AND owner_id; event viewing-responded DECLINED', async () => {
    const { service, manager, outbox } = setup();
    manager.query.mockResolvedValueOnce([[row({ status: 'DECLINED' })], 1]);
    const v = await service.decline(OWNER, VIEWING);

    const [sql, params] = manager.query.mock.calls[0];
    expect(sql).toMatch(/status = 'DECLINED'/);
    expect(sql).toMatch(/status = 'REQUESTED'/);
    expect(sql).toMatch(/owner_id = \$2/);
    expect(params).toEqual([VIEWING, OWNER]);
    expect(outbox.add).toHaveBeenCalledWith(manager, 'rental.viewing-responded', {
      viewingId: VIEWING,
      listingId: LISTING,
      tenantId: TENANT,
      ownerId: OWNER,
      decision: 'DECLINED',
    });
    expect(v.status).toBe('DECLINED');
  });

  it('test 5: confirm-viewed: REQUESTED -> CONFIRMED theo tenant_id; event viewing-confirmed', async () => {
    const { service, manager, outbox } = setup();
    manager.query.mockResolvedValueOnce([[row({ status: 'CONFIRMED' })], 1]);
    await service.confirmViewed(TENANT, VIEWING);
    expect(manager.query.mock.calls[0][0]).toMatch(/tenant_id = \$2/);
    expect(outbox.add.mock.calls[0][1]).toBe('rental.viewing-confirmed');
  });

  it('cancel: REQUESTED -> CANCELLED reason TENANT; event viewing-cancelled TENANT', async () => {
    const { service, manager, outbox } = setup();
    manager.query.mockResolvedValueOnce([
      [row({ status: 'CANCELLED', cancel_reason: 'TENANT' })],
      1,
    ]);
    await service.cancelByTenant(TENANT, VIEWING);
    expect(manager.query.mock.calls[0][0]).toMatch(/cancel_reason = 'TENANT'/);
    expect(outbox.add.mock.calls[0][2]).toMatchObject({ reason: 'TENANT' });
  });

  it.each([
    ['không có -> 404', null, RentalError.VIEWING_NOT_FOUND],
    [
      'test 4: không phải người liên quan -> 403',
      { ownerId: 'khac', tenantId: 'khac', status: 'REQUESTED' },
      'FORBIDDEN',
    ],
    [
      'test 6: đã CONFIRMED -> 409',
      { ownerId: OWNER, tenantId: TENANT, status: 'CONFIRMED' },
      RentalError.INVALID_TRANSITION,
    ],
  ])('UPDATE 0 dòng, đọc lại: %s', async (_, found, code) => {
    const { service, manager, outbox } = setup();
    manager.query.mockResolvedValueOnce([[], 0]);
    manager.findOneBy.mockResolvedValueOnce(found as Viewing | null);
    expect(await codeOf(service.cancelByTenant(TENANT, VIEWING))).toBe(code);
    expect(outbox.add).not.toHaveBeenCalled();
  });

  it('route 2 người khác (không phải chủ tin) -> 403 dù đúng là người thuê', async () => {
    const { service, manager } = setup();
    manager.query.mockResolvedValueOnce([[], 0]);
    manager.findOneBy.mockResolvedValueOnce({
      ownerId: OWNER,
      tenantId: TENANT,
      status: 'REQUESTED',
    });
    expect(await codeOf(service.decline(TENANT, VIEWING))).toBe('FORBIDDEN');
  });
});

describe('ViewingService.cancelOthersOnDeposit (payment.deposited)', () => {
  it('test 7: hủy REQUESTED của NGƯỜI KHÁC trên tin, mỗi dòng một event LISTING_DEPOSITED, cùng manager', async () => {
    const { service, outbox } = setup();
    const m = {
      query: jest
        .fn()
        .mockResolvedValue([
          [row({ id: 'v1', tenant_id: 'A' }), row({ id: 'v2', tenant_id: 'B' })],
          2,
        ]),
    };
    const n = await service.cancelOthersOnDeposit(m as never, LISTING, TENANT);

    expect(n).toBe(2);
    const [sql, params] = m.query.mock.calls[0];
    expect(sql).toMatch(/cancel_reason = 'LISTING_DEPOSITED'/);
    expect(sql).toMatch(/status = 'REQUESTED' AND tenant_id <> \$2/);
    expect(params).toEqual([LISTING, TENANT]);
    expect(outbox.add).toHaveBeenCalledTimes(2);
    expect(outbox.add).toHaveBeenCalledWith(m, 'rental.viewing-cancelled', {
      viewingId: 'v1',
      listingId: LISTING,
      tenantId: 'A',
      ownerId: OWNER,
      reason: 'LISTING_DEPOSITED',
    });
  });
});

describe('ViewingService.findMine (route 4)', () => {
  it('người thuê: lọc theo tenant_id; chủ trọ: theo owner_id; kèm listingId, status', async () => {
    const { service, viewings } = setup();
    const page = { page: 1, pageSize: 20, skip: 0, listingId: LISTING, status: 'REQUESTED' };
    await service.findMine({ sub: TENANT, roles: ['TENANT'] }, page as never);
    expect(viewings.findAndCount.mock.calls[0][0].where).toEqual({
      tenantId: TENANT,
      listingId: LISTING,
      status: 'REQUESTED',
    });
    await service.findMine({ sub: OWNER, roles: ['LANDLORD'] }, {
      ...page,
      listingId: undefined,
      status: undefined,
    } as never);
    expect(viewings.findAndCount.mock.calls[1][0].where).toEqual({ ownerId: OWNER });
  });
});
