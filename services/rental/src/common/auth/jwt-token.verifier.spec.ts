import { JwtService } from '@nestjs/jwt';
import { generateKeyPairSync } from 'node:crypto';
import { AppException } from '../errors/app.exception';
import { JwtVerifyConfig } from './jwt.config';
import { extractBearerToken, JwtTokenVerifier } from './jwt-token.verifier';

const pair = () =>
  generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
const mine = pair();
const other = pair();

const jwt = new JwtService({});
const sign = (payload: object, privateKey = mine.privateKey, options: object = {}) =>
  jwt.sign(payload, { algorithm: 'RS256', privateKey, issuer: 'realestate-identity', ...options });

const config: JwtVerifyConfig = {
  key: mine.publicKey,
  algorithms: ['RS256'],
  kind: 'public-key',
  issuer: 'realestate-identity',
};
const verifier = new JwtTokenVerifier(jwt, config);

async function codeOf(promise: Promise<unknown>): Promise<{ code: string; status: number }> {
  try {
    await promise;
  } catch (e) {
    const ex = e as AppException;
    return { code: ex.code, status: ex.getStatus() };
  }
  throw new Error('phải ném AppException');
}

describe('JwtTokenVerifier', () => {
  it('token hợp lệ -> { sub, roles, exp }', async () => {
    const token = sign({ sub: 'u-1', roles: ['TENANT'] }, mine.privateKey, { expiresIn: 60 });
    await expect(verifier.verify(token)).resolves.toEqual({
      sub: 'u-1',
      roles: ['TENANT'],
      exp: expect.any(Number),
    });
  });

  it('thiếu roles -> roles rỗng', async () => {
    const token = sign({ sub: 'u-1' }, mine.privateKey, { expiresIn: 60 });
    await expect(verifier.verify(token)).resolves.toMatchObject({ roles: [] });
  });

  it('sai chữ ký -> 401 AUTH_TOKEN_INVALID', async () => {
    const token = sign({ sub: 'u-1' }, other.privateKey, { expiresIn: 60 });
    await expect(codeOf(verifier.verify(token))).resolves.toEqual({
      code: 'AUTH_TOKEN_INVALID',
      status: 401,
    });
  });

  it('hết hạn -> 401 AUTH_TOKEN_EXPIRED', async () => {
    const token = sign({ sub: 'u-1' }, mine.privateKey, { expiresIn: -10 });
    await expect(codeOf(verifier.verify(token))).resolves.toEqual({
      code: 'AUTH_TOKEN_EXPIRED',
      status: 401,
    });
  });

  it('sai iss -> 401 AUTH_TOKEN_INVALID', async () => {
    const token = sign({ sub: 'u-1' }, mine.privateKey, { expiresIn: 60, issuer: 'ke-gia-mao' });
    await expect(codeOf(verifier.verify(token))).resolves.toMatchObject({
      code: 'AUTH_TOKEN_INVALID',
    });
  });

  it('chặn đổi thuật toán: HS256 ký bằng chính khóa công khai -> AUTH_TOKEN_INVALID', async () => {
    const forged = jwt.sign(
      { sub: 'u-1' },
      { algorithm: 'HS256', secret: mine.publicKey, issuer: 'realestate-identity', expiresIn: 60 },
    );
    await expect(codeOf(verifier.verify(forged))).resolves.toMatchObject({
      code: 'AUTH_TOKEN_INVALID',
    });
  });

  it('thiếu sub hoặc roles sai kiểu -> 401 AUTH_TOKEN_INVALID', async () => {
    const noSub = sign({ roles: ['TENANT'] }, mine.privateKey, { expiresIn: 60 });
    const badRoles = sign({ sub: 'u-1', roles: 'TENANT' }, mine.privateKey, { expiresIn: 60 });
    for (const token of [noSub, badRoles]) {
      await expect(codeOf(verifier.verify(token))).resolves.toMatchObject({
        code: 'AUTH_TOKEN_INVALID',
      });
    }
  });

  it('không cấu hình khóa -> 503 AUTH_NOT_CONFIGURED (không bao giờ để hở)', async () => {
    const unconfigured = new JwtTokenVerifier(jwt, null);
    expect(unconfigured.isConfigured).toBe(false);
    expect(verifier.isConfigured).toBe(true);
    await expect(codeOf(unconfigured.verify('x.y.z'))).resolves.toEqual({
      code: 'AUTH_NOT_CONFIGURED',
      status: 503,
    });
  });
});

describe('extractBearerToken', () => {
  it.each([
    ['Bearer abc.def.ghi', 'abc.def.ghi'],
    ['bearer abc', 'abc'],
    [['Bearer abc'], 'abc'],
  ])('%j -> %s', (header, expected) => {
    expect(extractBearerToken(header)).toBe(expected);
  });

  it.each([[undefined], [''], ['Basic abc'], ['Bearer'], ['Bearer a b']])(
    '%j -> undefined',
    (h) => {
      expect(extractBearerToken(h)).toBeUndefined();
    },
  );
});
