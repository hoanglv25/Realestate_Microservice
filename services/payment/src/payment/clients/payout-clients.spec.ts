import { AppException } from '../../common/errors/app.exception';
import { IdentityClient } from './identity.client';
import { RentalClient } from './rental.client';

const URLS = { rental: 'http://rental:3003', identity: 'http://identity:3001' };

function setup(get: jest.Mock = jest.fn()) {
  const http = { get };
  return {
    get,
    rental: new RentalClient(http as never, URLS),
    identity: new IdentityClient(http as never, URLS),
  };
}

describe('RentalClient', () => {
  it('withdrawalEligibility: GET /internal/deposits/:id/withdrawal-eligibility (GET được retry), trả `data`', async () => {
    const view = {
      depositId: 'D1',
      ownerId: 'O1',
      amountVnd: 3_000_000,
      status: 'RELEASED',
      eligible: true,
      missing: [],
    };
    const { get, rental } = setup(jest.fn().mockResolvedValue(view));
    await expect(rental.withdrawalEligibility('D1')).resolves.toEqual(view);
    expect(get).toHaveBeenCalledWith(
      'http://rental:3003/internal/deposits/D1/withdrawal-eligibility',
    );
  });

  it('lỗi của rental (404 RENTAL_DEPOSIT_NOT_FOUND, 503) chuyển nguyên', async () => {
    const err = new AppException('RENTAL_DEPOSIT_NOT_FOUND', 'x', 404);
    const { rental } = setup(jest.fn().mockRejectedValue(err));
    await expect(rental.withdrawalEligibility('D1')).rejects.toBe(err);
  });
});

describe('IdentityClient', () => {
  it('getBankAccount: GET /internal/users/:id/bank-account, trả số đầy đủ', async () => {
    const acc = {
      userId: 'U1',
      bankName: 'Vietcombank',
      accountHolder: 'TRAN THI BINH',
      accountNumber: '0123456789',
    };
    const { get, identity } = setup(jest.fn().mockResolvedValue(acc));
    await expect(identity.getBankAccount('U1')).resolves.toEqual(acc);
    expect(get).toHaveBeenCalledWith('http://identity:3001/internal/users/U1/bank-account');
  });

  it('chưa khai (404 IDENTITY_BANK_ACCOUNT_NOT_FOUND) -> null', async () => {
    const { identity } = setup(
      jest.fn().mockRejectedValue(new AppException('IDENTITY_BANK_ACCOUNT_NOT_FOUND', 'x', 404)),
    );
    await expect(identity.getBankAccount('U1')).resolves.toBeNull();
  });

  it.each([
    ['404 mã khác', new AppException('NOT_FOUND', 'x', 404)],
    ['503', new AppException('UPSTREAM_UNAVAILABLE', 'x', 503)],
    ['504', new AppException('UPSTREAM_TIMEOUT', 'x', 504)],
  ])('lỗi khác (%s) chuyển nguyên', async (_name, err) => {
    const { identity } = setup(jest.fn().mockRejectedValue(err));
    await expect(identity.getBankAccount('U1')).rejects.toBe(err);
  });
});
