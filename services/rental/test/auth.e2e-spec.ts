import { Controller, Get } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { generateKeyPairSync } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AuthUser } from '../src/common/auth/authenticated-user';
import { CurrentUser } from '../src/common/auth/current-user.decorator';
import { Public } from '../src/common/auth/public.decorator';
import { Roles } from '../src/common/auth/roles.decorator';
import { createTestApp, TestApp } from './helpers/create-test-app';

@Controller('test-auth')
class TestAuthController {
  @Public()
  @Get('public')
  open(): { ok: boolean } {
    return { ok: true };
  }

  @Get('me')
  me(@CurrentUser() user: AuthUser): AuthUser {
    return user;
  }

  @Get('sub')
  sub(@CurrentUser('sub') sub: string): { sub: string } {
    return { sub };
  }

  @Roles('ADMIN')
  @Get('admin')
  admin(): { ok: boolean } {
    return { ok: true };
  }

  @Roles('ADMIN', 'LANDLORD')
  @Get('staff')
  staff(): { ok: boolean } {
    return { ok: true };
  }
}

const SECRET = 'bi-mat-dev-toi-thieu-16-ky-tu';
const signer = new JwtService({});
const hs256 = (
  claims: Record<string, unknown>,
  secret = SECRET,
  expiresIn: number | string = '1h',
) => signer.sign(claims, { secret, algorithm: 'HS256', expiresIn: expiresIn as never });
const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });

async function withApp<T>(env: Record<string, string>, fn: (t: TestApp) => Promise<T>): Promise<T> {
  const saved: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(env)) {
    saved[k] = process.env[k];
    process.env[k] = v;
  }
  const t = await createTestApp([TestAuthController]);
  try {
    return await fn(t);
  } finally {
    await t.app.close();
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

describe('Xác thực JWT: chưa cấu hình khóa', () => {
  it('route @Public và /health vẫn chạy; route khác 503 AUTH_NOT_CONFIGURED (không mở toang)', async () => {
    await withApp({}, async (t) => {
      expect((await t.http().get('/api/v1/test-auth/public')).status).toBe(200);
      expect((await t.http().get('/health')).status).toBe(200);
      const res = await t.http().get('/api/v1/test-auth/me');
      expect(res.status).toBe(503);
      expect(res.body.error.code).toBe('AUTH_NOT_CONFIGURED');
    });
  });
});

describe('Xác thực JWT: HS256 (JWT_SECRET)', () => {
  let t: TestApp;
  const saved = process.env.JWT_SECRET;

  beforeAll(async () => {
    process.env.JWT_SECRET = SECRET;
    t = await createTestApp([TestAuthController]);
  });
  afterAll(async () => {
    await t.app.close();
    if (saved === undefined) delete process.env.JWT_SECRET;
    else process.env.JWT_SECRET = saved;
  });

  it('không có token -> 401 AUTH_TOKEN_MISSING; /health và @Public vẫn mở', async () => {
    const res = await t.http().get('/api/v1/test-auth/me');
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('AUTH_TOKEN_MISSING');
    expect((await t.http().get('/api/v1/test-auth/public')).status).toBe(200);
    expect((await t.http().get('/health')).status).toBe(200);
  });

  it('Authorization không phải Bearer -> AUTH_TOKEN_MISSING', async () => {
    const res = await t.http().get('/api/v1/test-auth/me').set('Authorization', 'Basic abc');
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('AUTH_TOKEN_MISSING');
  });

  it('token hợp lệ -> 200, @CurrentUser trả { sub, roles, exp }', async () => {
    const token = hs256({ sub: 'user-1', roles: ['LANDLORD'] });
    const res = await t.http().get('/api/v1/test-auth/me').set(bearer(token));
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ sub: 'user-1', roles: ['LANDLORD'], exp: expect.any(Number) });

    const sub = await t.http().get('/api/v1/test-auth/sub').set(bearer(token));
    expect(sub.body.data).toEqual({ sub: 'user-1' });
  });

  it('thiếu roles trong token -> roles = []', async () => {
    const res = await t
      .http()
      .get('/api/v1/test-auth/me')
      .set(bearer(hs256({ sub: 'u2' })));
    expect(res.body.data.roles).toEqual([]);
  });

  it('sai chữ ký -> 401 AUTH_TOKEN_INVALID', async () => {
    const token = hs256({ sub: 'u', roles: [] }, 'mot-bi-mat-khac-nhau-hoan-toan');
    const res = await t.http().get('/api/v1/test-auth/me').set(bearer(token));
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('AUTH_TOKEN_INVALID');
  });

  it('hết hạn -> 401 AUTH_TOKEN_EXPIRED', async () => {
    const token = hs256({ sub: 'u', roles: [] }, SECRET, -10);
    const res = await t.http().get('/api/v1/test-auth/me').set(bearer(token));
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('AUTH_TOKEN_EXPIRED');
  });

  it('token alg "none" bị từ chối', async () => {
    const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url');
    const none = `${b64({ alg: 'none', typ: 'JWT' })}.${b64({ sub: 'hacker', roles: ['ADMIN'], exp: 9999999999 })}.`;
    const res = await t.http().get('/api/v1/test-auth/admin').set(bearer(none));
    expect(res.status).toBe(401);
  });

  it('claims sai (thiếu sub, roles không phải mảng chuỗi, thiếu exp) -> 401 AUTH_TOKEN_INVALID', async () => {
    const noSub = hs256({ roles: [] });
    const badRoles = hs256({ sub: 'u', roles: 'ADMIN' });
    const noExp = signer.sign({ sub: 'u' }, { secret: SECRET, algorithm: 'HS256' });
    for (const token of [noSub, badRoles, noExp]) {
      const res = await t.http().get('/api/v1/test-auth/me').set(bearer(token));
      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe('AUTH_TOKEN_INVALID');
    }
  });

  it('@Roles: đủ vai trò -> 200; thiếu -> 403 FORBIDDEN_ROLE; chỉ cần một trong nhiều vai trò', async () => {
    const admin = hs256({ sub: 'a', roles: ['ADMIN'] });
    const tenant = hs256({ sub: 't', roles: ['TENANT'] });
    const landlord = hs256({ sub: 'l', roles: ['LANDLORD'] });

    expect((await t.http().get('/api/v1/test-auth/admin').set(bearer(admin))).status).toBe(200);

    const denied = await t.http().get('/api/v1/test-auth/admin').set(bearer(tenant));
    expect(denied.status).toBe(403);
    expect(denied.body.error.code).toBe('FORBIDDEN_ROLE');
    expect(denied.body.error.details).toEqual({ requiredAnyOf: ['ADMIN'] });

    expect((await t.http().get('/api/v1/test-auth/staff').set(bearer(landlord))).status).toBe(200);
    expect((await t.http().get('/api/v1/test-auth/staff').set(bearer(tenant))).status).toBe(403);
  });

  it('lỗi xác thực có đủ format { error: { code, message }, meta }', async () => {
    const res = await t.http().get('/api/v1/test-auth/me').set('X-Request-ID', 'auth-1');
    expect(res.body).toEqual({
      error: { code: 'AUTH_TOKEN_MISSING', message: expect.any(String) },
      meta: { correlationId: 'auth-1', timestamp: expect.any(String) },
    });
  });
});

describe('Xác thực JWT: yêu cầu issuer', () => {
  it('JWT_ISSUER đặt thì token sai issuer bị từ chối', async () => {
    await withApp({ JWT_SECRET: SECRET, JWT_ISSUER: 'realestate-identity' }, async (t) => {
      const good = signer.sign(
        { sub: 'u' },
        { secret: SECRET, algorithm: 'HS256', expiresIn: '1h', issuer: 'realestate-identity' },
      );
      const bad = signer.sign(
        { sub: 'u' },
        { secret: SECRET, algorithm: 'HS256', expiresIn: '1h', issuer: 'ke-gia-mao' },
      );
      expect((await t.http().get('/api/v1/test-auth/me').set(bearer(good))).status).toBe(200);
      expect((await t.http().get('/api/v1/test-auth/me').set(bearer(bad))).status).toBe(401);
    });
  });
});

describe('Xác thực JWT: RS256 (khóa công khai)', () => {
  const { publicKey, privateKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
  const rs256 = (claims: Record<string, unknown>) =>
    signer.sign(claims, { privateKey, algorithm: 'RS256', expiresIn: '1h' });

  it('JWT_PUBLIC_KEY (PEM, xuống dòng viết \\n) xác thực được token RS256', async () => {
    const oneLine = publicKey.trim().replace(/\n/g, '\\n');
    await withApp({ JWT_PUBLIC_KEY: oneLine }, async (t) => {
      const res = await t
        .http()
        .get('/api/v1/test-auth/me')
        .set(bearer(rs256({ sub: 'rsa-user', roles: ['ADMIN'] })));
      expect(res.status).toBe(200);
      expect(res.body.data.sub).toBe('rsa-user');
    });
  });

  it('JWT_PUBLIC_KEY_PATH đọc khóa từ file', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'jwt-'));
    const file = join(dir, 'public.pem');
    writeFileSync(file, publicKey);
    try {
      await withApp({ JWT_PUBLIC_KEY_PATH: file }, async (t) => {
        const res = await t
          .http()
          .get('/api/v1/test-auth/me')
          .set(bearer(rs256({ sub: 'from-file' })));
        expect(res.status).toBe(200);
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('chặn tấn công đổi thuật toán: token HS256 ký bằng CHÍNH khóa công khai bị từ chối', async () => {
    await withApp({ JWT_PUBLIC_KEY: publicKey.trim().replace(/\n/g, '\\n') }, async (t) => {
      const forged = signer.sign(
        { sub: 'hacker', roles: ['ADMIN'] },
        { secret: publicKey, algorithm: 'HS256', expiresIn: '1h' },
      );
      const res = await t.http().get('/api/v1/test-auth/admin').set(bearer(forged));
      expect(res.status).toBe(401);
    });
  });

  it('JWT_PUBLIC_KEY_PATH sai đường dẫn -> app dừng khi khởi động với thông báo rõ', async () => {
    await expect(
      withApp({ JWT_PUBLIC_KEY_PATH: join(tmpdir(), 'khong-ton-tai.pem') }, async () => undefined),
    ).rejects.toThrow(/JWT_PUBLIC_KEY_PATH/);
  });
});
