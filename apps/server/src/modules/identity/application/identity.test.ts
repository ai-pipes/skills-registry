import { beforeEach, describe, expect, it } from 'vite-plus/test';
import { makeEnv, repeat, seedUser, type TestEnv } from '../../../../test/identity/fakes.ts';
import type { Principal } from '../domain/user.ts';
import { authenticateSession, login, logout } from './sessions.ts';
import { authenticateToken, createToken, listTokens, revokeToken } from './tokens.ts';
import {
  actAs,
  bootstrapAdmin,
  createUser,
  listUsers,
  provisionUser,
  resetPassword,
  setDisabled,
} from './users.ts';

const PW = 'correct-horse-battery';
const HOUR = 3600_000;
let env: TestEnv;
beforeEach(() => {
  env = makeEnv();
});

const principal = (u: { id: string; login: string; role: 'admin' | 'member' }): Principal => ({
  userId: u.id,
  login: u.login,
  role: u.role,
  via: 'session',
});

describe('login', () => {
  it('creates a session for the right password and stores only a hash', async () => {
    await seedUser(env, 'alice');
    const r = await login(env.deps, { login: 'alice', password: PW, ip: '1.1.1.1' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.sessionId).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(env.sessions.rows).toHaveLength(1);
    expect(JSON.stringify(env.sessions.rows)).not.toContain(r.value.sessionId);
    expect(r.value.expiresAt.getTime()).toBe(env.time.now.getTime() + 30 * 24 * HOUR);
    expect(env.audit.map((a) => a.action)).toContain('auth.login');
  });

  it('rotates the session id on every login', async () => {
    await seedUser(env, 'alice');
    const a = await login(env.deps, { login: 'alice', password: PW, ip: '1.1.1.1' });
    const b = await login(env.deps, { login: 'alice', password: PW, ip: '1.1.1.1' });
    expect(a.ok && b.ok && a.value.sessionId !== b.value.sessionId).toBe(true);
  });

  it('rejects a wrong password', async () => {
    await seedUser(env, 'alice');
    const r = await login(env.deps, { login: 'alice', password: 'nope-nope-nope', ip: 'ip' });
    expect(r).toMatchObject({ ok: false, error: { code: 'invalid_credentials' } });
    expect(env.audit.map((a) => a.action)).toContain('auth.login_failed');
  });

  it('locks on the 6th failed attempt even with the right password', async () => {
    await seedUser(env, 'alice');
    const failures = await repeat(5, (i) =>
      login(env.deps, { login: 'alice', password: 'bad-bad-bad-bad', ip: `ip${i}` }),
    );
    for (const r of failures) {
      expect(r).toMatchObject({ ok: false, error: { code: 'invalid_credentials' } });
    }
    const r = await login(env.deps, { login: 'alice', password: PW, ip: 'ip9' });
    expect(r).toMatchObject({ ok: false, error: { code: 'locked' } });
  });

  it('a successful login resets the login counter', async () => {
    await seedUser(env, 'alice');
    await repeat(4, () =>
      login(env.deps, { login: 'alice', password: 'bad-bad-bad-bad', ip: 'a' }),
    );
    expect((await login(env.deps, { login: 'alice', password: PW, ip: 'a' })).ok).toBe(true);
    await repeat(4, () =>
      login(env.deps, { login: 'alice', password: 'bad-bad-bad-bad', ip: 'a' }),
    );
    expect((await login(env.deps, { login: 'alice', password: PW, ip: 'a' })).ok).toBe(true);
  });

  it('login matching is case-insensitive for the limiter key', async () => {
    await seedUser(env, 'alice');
    const variants = ['alice', 'ALICE', 'Alice', 'aLice', 'alICE'];
    await repeat(5, (i) =>
      login(env.deps, { login: variants[i] ?? '', password: 'bad-bad-bad-bad', ip: 'a' }),
    );
    const r = await login(env.deps, { login: 'ALICE', password: PW, ip: 'a' });
    expect(r).toMatchObject({ ok: false, error: { code: 'locked' } });
  });

  it('unknown login gives invalid_credentials and still runs verify', async () => {
    const r = await login(env.deps, { login: 'ghost', password: 'whatever-pass-1', ip: 'ip' });
    expect(r).toMatchObject({ ok: false, error: { code: 'invalid_credentials' } });
    expect(env.hasher.verifyCalls).toBe(1);
  });

  it('unknown login can be locked too (no user enumeration)', async () => {
    await repeat(5, (i) =>
      login(env.deps, { login: 'ghost', password: 'whatever-pass-1', ip: `ip${i}` }),
    );
    const r = await login(env.deps, { login: 'ghost', password: 'whatever-pass-1', ip: 'x' });
    expect(r).toMatchObject({ ok: false, error: { code: 'locked' } });
  });

  it('rate limits by IP', async () => {
    await repeat(20, (i) =>
      login(env.deps, { login: `u${i}`, password: 'whatever-pass-1', ip: '9.9.9.9' }),
    );
    const r = await login(env.deps, { login: 'u99', password: 'whatever-pass-1', ip: '9.9.9.9' });
    expect(r).toMatchObject({ ok: false, error: { code: 'rate_limited' } });
  });

  it('successful logins do not consume the per-IP budget', async () => {
    await seedUser(env, 'alice');
    const results = await repeat(25, () =>
      login(env.deps, { login: 'alice', password: PW, ip: '7.7.7.7' }),
    );
    expect(results.every((r) => r.ok)).toBe(true);
  });

  it('concurrent wrong-password logins are capped by the per-IP in-flight gate', async () => {
    await seedUser(env, 'alice');
    env.hasher.verify = async (hash, p) => {
      env.hasher.verifyCalls++;
      await new Promise((r) => setTimeout(r, 0));
      return hash === `fake$${p}`;
    };
    const rs = await Promise.all(
      Array.from({ length: 30 }, (_, i) =>
        login(env.deps, { login: `u${i}`, password: 'whatever-pass-1', ip: '4.4.4.4' }),
      ),
    );
    expect(env.hasher.verifyCalls).toBeLessThanOrEqual(25);
    expect(rs.filter((r) => !r.ok && r.error.code === 'rate_limited')).toHaveLength(25);
    // the gate is released afterwards
    const next = await login(env.deps, { login: 'alice', password: PW, ip: '4.4.4.4' });
    expect(next.ok).toBe(true);
  });

  it('successes interleaved with failures neither consume nor reset the IP budget', async () => {
    await seedUser(env, 'alice');
    const rs = await repeat(45, (i) =>
      i % 2 === 0 && i < 40
        ? login(env.deps, { login: `x${i}`, password: 'whatever-pass-1', ip: '6.6.6.6' })
        : login(env.deps, { login: 'alice', password: PW, ip: '6.6.6.6' }),
    );
    // i = 0,2,...,38 are 20 failures; successes at odd i continue until the lock
    expect(rs.slice(0, 40).every((r) => r.ok || r.error.code === 'invalid_credentials')).toBe(true);
    const after = await login(env.deps, { login: 'y', password: 'whatever-pass-1', ip: '6.6.6.6' });
    expect(after).toMatchObject({ ok: false, error: { code: 'rate_limited' } });
    const valid = await login(env.deps, { login: 'alice', password: PW, ip: '6.6.6.6' });
    expect(valid).toMatchObject({ ok: false, error: { code: 'rate_limited' } });
  });

  it('a blocked IP is refused even with correct credentials', async () => {
    await seedUser(env, 'alice');
    await repeat(21, (i) =>
      login(env.deps, { login: `u${i}`, password: 'whatever-pass-1', ip: '9.9.9.9' }),
    );
    const r = await login(env.deps, { login: 'alice', password: PW, ip: '9.9.9.9' });
    expect(r).toMatchObject({ ok: false, error: { code: 'rate_limited' } });
  });

  it('oversized login or password: invalid_credentials, dummy verify, no login-limiter key', async () => {
    const hugeLogin = 'a'.repeat(10_000);
    const r1 = await login(env.deps, { login: hugeLogin, password: PW, ip: 'ip' });
    expect(r1).toMatchObject({ ok: false, error: { code: 'invalid_credentials' } });
    const r2 = await login(env.deps, { login: 'alice', password: 'p'.repeat(1_000_000), ip: 'ip' });
    expect(r2).toMatchObject({ ok: false, error: { code: 'invalid_credentials' } });
    expect(env.hasher.verifyCalls).toBe(2);
    expect(env.loginLimiter.has(hugeLogin)).toBe(false);
    expect(env.loginLimiter.has('alice')).toBe(false);
    expect(JSON.stringify(env.audit)).not.toContain(hugeLogin);
  });

  it('oversized input still counts as an IP failure', async () => {
    const rs = await repeat(21, () =>
      login(env.deps, { login: 'a'.repeat(129), password: PW, ip: '5.5.5.5' }),
    );
    expect(rs[20]).toMatchObject({ ok: false, error: { code: 'rate_limited' } });
  });

  it('disabled user with the right password gets disabled; wrong password stays generic', async () => {
    const u = await seedUser(env, 'alice');
    u.disabled = true;
    expect(await login(env.deps, { login: 'alice', password: PW, ip: 'a' })).toMatchObject({
      ok: false,
      error: { code: 'disabled' },
    });
    expect(
      await login(env.deps, { login: 'alice', password: 'bad-bad-bad-bad', ip: 'a' }),
    ).toMatchObject({ ok: false, error: { code: 'invalid_credentials' } });
  });
});

async function session(): Promise<{ id: string; userId: string }> {
  const u = await seedUser(env, 'alice');
  const r = await login(env.deps, { login: 'alice', password: PW, ip: 'a' });
  if (!r.ok) throw new Error('login failed');
  return { id: r.value.sessionId, userId: u.id };
}

describe('sessions', () => {
  it('authenticates and slides the idle window', async () => {
    const s = await session();
    env.time.now = new Date(env.time.now.getTime() + 11 * HOUR);
    expect(await authenticateSession(env.deps, { sessionId: s.id })).toMatchObject({
      userId: s.userId,
      login: 'alice',
      via: 'session',
    });
    env.time.now = new Date(env.time.now.getTime() + 11 * HOUR);
    expect(await authenticateSession(env.deps, { sessionId: s.id })).not.toBeNull();
  });

  it('expires after 12h idle', async () => {
    const s = await session();
    env.time.now = new Date(env.time.now.getTime() + 12 * HOUR + 1);
    expect(await authenticateSession(env.deps, { sessionId: s.id })).toBeNull();
    expect(env.sessions.rows).toHaveLength(0);
  });

  it('expires absolutely after 30 days even when kept active', async () => {
    const s = await session();
    const results = await repeat(70, async () => {
      env.time.now = new Date(env.time.now.getTime() + 11 * HOUR);
      return authenticateSession(env.deps, { sessionId: s.id });
    });
    // step k is (k + 1) * 11h in; the 30-day (720h) limit is first crossed at k = 65
    expect(results.findIndex((r) => r === null)).toBe(65);
  });

  it('rejects unknown ids and ids of the wrong shape', async () => {
    expect(await authenticateSession(env.deps, { sessionId: 'nope' })).toBeNull();
  });

  it('rejects sessions of disabled users', async () => {
    const s = await session();
    const u = await env.users.findById(s.userId);
    if (u) u.disabled = true;
    expect(await authenticateSession(env.deps, { sessionId: s.id })).toBeNull();
  });

  it('logout destroys the session and audits', async () => {
    const s = await session();
    await logout(env.deps, { sessionId: s.id });
    expect(await authenticateSession(env.deps, { sessionId: s.id })).toBeNull();
    expect(env.audit.map((a) => a.action)).toContain('auth.logout');
  });

  it('logout of an unknown session is a no-op', async () => {
    await logout(env.deps, { sessionId: 'nope' });
    expect(env.audit.map((a) => a.action)).not.toContain('auth.logout');
  });
});

describe('api tokens', () => {
  it('creates sk_ tokens and persists only the hash', async () => {
    const u = await seedUser(env, 'alice');
    const t = await createToken(env.deps, { principal: principal(u), name: 'ci' });
    expect(t.token).toMatch(/^sk_[A-Za-z0-9_-]{43}$/);
    expect(t.prefix).toBe(t.token.slice(0, 10));
    expect(JSON.stringify(env.tokens.rows)).not.toContain(t.token);
    expect(env.tokens.rows[0]?.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(env.audit.map((a) => a.action)).toContain('token.create');
  });

  it('authenticates a valid token', async () => {
    const u = await seedUser(env, 'alice', 'admin');
    const t = await createToken(env.deps, { principal: principal(u), name: 'ci' });
    const r = await authenticateToken(env.deps, { token: t.token, ip: '1.1.1.1' });
    expect(r).toEqual({
      ok: true,
      value: { userId: u.id, login: 'alice', role: 'admin', via: 'token' },
    });
  });

  it('touches last_used_at at most once a minute', async () => {
    const u = await seedUser(env, 'alice');
    const t = await createToken(env.deps, { principal: principal(u), name: 'ci' });
    await authenticateToken(env.deps, { token: t.token, ip: 'a' });
    const first = env.tokens.rows[0]?.lastUsedAt;
    expect(first).toEqual(env.time.now);
    env.time.now = new Date(env.time.now.getTime() + 30_000);
    await authenticateToken(env.deps, { token: t.token, ip: 'a' });
    expect(env.tokens.rows[0]?.lastUsedAt).toEqual(first);
    env.time.now = new Date(env.time.now.getTime() + 31_000);
    await authenticateToken(env.deps, { token: t.token, ip: 'a' });
    expect(env.tokens.rows[0]?.lastUsedAt).toEqual(env.time.now);
  });

  it('rejects oversized or non-sk_ tokens without hashing, counting an IP failure', async () => {
    let hashed = 0;
    const inner = env.deps.sha256;
    env.deps.sha256 = {
      hex: (x) => {
        hashed++;
        return inner.hex(x);
      },
      timingSafeEqual: (x, y) => inner.timingSafeEqual(x, y),
    };
    const bad = await Promise.all(
      ['sk_' + 'a'.repeat(98), 'x'.repeat(1_000_000), 'Bearer abc', ''].map((token) =>
        authenticateToken(env.deps, { token, ip: 'ip' }),
      ),
    );
    for (const r of bad) {
      expect(r).toMatchObject({ ok: false, error: { code: 'invalid_token' } });
    }
    expect(hashed).toBe(0);
    const ok100 = await authenticateToken(env.deps, { token: 'sk_' + 'a'.repeat(97), ip: 'ip' });
    expect(ok100).toMatchObject({ ok: false, error: { code: 'invalid_token' } });
    expect(hashed).toBe(1);
    const flood = await repeat(30, () =>
      authenticateToken(env.deps, { token: 'x'.repeat(200), ip: 'ip' }),
    );
    expect(flood.some((r) => !r.ok && r.error.code === 'rate_limited')).toBe(true);
  });

  it('rejects unknown tokens', async () => {
    const r = await authenticateToken(env.deps, { token: 'sk_nothing', ip: 'a' });
    expect(r).toMatchObject({ ok: false, error: { code: 'invalid_token' } });
  });

  it('a revoked token fails immediately', async () => {
    const u = await seedUser(env, 'alice');
    const p = principal(u);
    const t = await createToken(env.deps, { principal: p, name: 'ci' });
    expect((await revokeToken(env.deps, { principal: p, id: t.id })).ok).toBe(true);
    const r = await authenticateToken(env.deps, { token: t.token, ip: 'a' });
    expect(r).toMatchObject({ ok: false, error: { code: 'invalid_token' } });
    expect(env.audit.map((a) => a.action)).toContain('token.revoke');
  });

  it('revoking an already revoked token is ok and writes no second audit record', async () => {
    const u = await seedUser(env, 'alice');
    const p = principal(u);
    const t = await createToken(env.deps, { principal: p, name: 'ci' });
    await revokeToken(env.deps, { principal: p, id: t.id });
    const again = await revokeToken(env.deps, { principal: p, id: t.id });
    expect(again.ok).toBe(true);
    expect(env.audit.filter((a) => a.action === 'token.revoke')).toHaveLength(1);
  });

  it('a token of a disabled user fails', async () => {
    const u = await seedUser(env, 'alice');
    const t = await createToken(env.deps, { principal: principal(u), name: 'ci' });
    u.disabled = true;
    const r = await authenticateToken(env.deps, { token: t.token, ip: 'a' });
    expect(r).toMatchObject({ ok: false, error: { code: 'invalid_token' } });
  });

  it('rate limits the 31st failed check from one IP', async () => {
    const first30 = await repeat(30, (i) =>
      authenticateToken(env.deps, { token: `sk_bad${i}`, ip: '2.2.2.2' }),
    );
    for (const r of first30) {
      expect(r).toMatchObject({ ok: false, error: { code: 'invalid_token' } });
    }
    const r = await authenticateToken(env.deps, { token: 'sk_bad31', ip: '2.2.2.2' });
    expect(r).toMatchObject({ ok: false, error: { code: 'rate_limited' } });
    const other = await authenticateToken(env.deps, { token: 'sk_bad31', ip: '3.3.3.3' });
    expect(other).toMatchObject({ ok: false, error: { code: 'invalid_token' } });
  });

  it('successful checks do not consume the failure budget', async () => {
    const u = await seedUser(env, 'alice');
    const t = await createToken(env.deps, { principal: principal(u), name: 'ci' });
    const results = await repeat(40, () =>
      authenticateToken(env.deps, { token: t.token, ip: 'a' }),
    );
    expect(results.every((r) => r.ok)).toBe(true);
  });

  it('lists only own tokens, without secrets', async () => {
    const a = await seedUser(env, 'alice');
    const b = await seedUser(env, 'bob');
    await createToken(env.deps, { principal: principal(a), name: 'one' });
    await createToken(env.deps, { principal: principal(b), name: 'two' });
    const list = await listTokens(env.deps, { principal: principal(a) });
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ name: 'one', lastUsedAt: null, revokedAt: null });
    expect(Object.keys(list[0] ?? {}).toSorted()).toEqual(
      ['createdAt', 'id', 'lastUsedAt', 'name', 'prefix', 'revokedAt'].toSorted(),
    );
  });

  it('only the owner or an admin may revoke', async () => {
    const a = await seedUser(env, 'alice');
    const b = await seedUser(env, 'bob');
    const root = await seedUser(env, 'root', 'admin');
    const t = await createToken(env.deps, { principal: principal(a), name: 'x' });
    expect(await revokeToken(env.deps, { principal: principal(b), id: t.id })).toMatchObject({
      ok: false,
      error: { code: 'forbidden' },
    });
    expect((await revokeToken(env.deps, { principal: principal(root), id: t.id })).ok).toBe(true);
    expect(await revokeToken(env.deps, { principal: principal(root), id: 'zzz' })).toMatchObject({
      ok: false,
      error: { code: 'not_found' },
    });
  });
});

describe('user management', () => {
  it('forbids members', async () => {
    const m = principal(await seedUser(env, 'mem'));
    const other = await seedUser(env, 'other');
    expect(
      await createUser(env.deps, { principal: m, login: 'x', password: PW, role: 'member' }),
    ).toMatchObject({ ok: false, error: { code: 'forbidden' } });
    expect(await listUsers(env.deps, { principal: m })).toMatchObject({
      ok: false,
      error: { code: 'forbidden' },
    });
    expect(
      await resetPassword(env.deps, { principal: m, userId: other.id, password: PW }),
    ).toMatchObject({ ok: false, error: { code: 'forbidden' } });
    expect(
      await setDisabled(env.deps, { principal: m, userId: other.id, disabled: true }),
    ).toMatchObject({ ok: false, error: { code: 'forbidden' } });
  });

  it('admin creates users with a hashed password', async () => {
    const admin = principal(await seedUser(env, 'root', 'admin'));
    const r = await createUser(env.deps, {
      principal: admin,
      login: 'bob',
      password: 'a-long-enough-pass',
      role: 'member',
    });
    expect(r.ok).toBe(true);
    const bob = await env.users.findByLogin('bob');
    expect(bob?.passwordHash).toBe('fake$a-long-enough-pass');
    expect(env.audit.map((a) => a.action)).toContain('user.create');
    const list = await listUsers(env.deps, { principal: admin });
    expect(list.ok && list.value.map((u) => u.login)).toEqual(['root', 'bob']);
    expect(JSON.stringify(list)).not.toContain('passwordHash');
  });

  it('rejects weak passwords, duplicate and blank logins', async () => {
    const admin = principal(await seedUser(env, 'root', 'admin'));
    expect(
      await createUser(env.deps, {
        principal: admin,
        login: 'bob',
        password: 'short',
        role: 'member',
      }),
    ).toMatchObject({ ok: false, error: { code: 'weak_password' } });
    expect(
      await createUser(env.deps, { principal: admin, login: 'ROOT', password: PW, role: 'member' }),
    ).toMatchObject({ ok: false, error: { code: 'user_exists' } });
    expect(
      await createUser(env.deps, { principal: admin, login: '  ', password: PW, role: 'member' }),
    ).toMatchObject({ ok: false, error: { code: 'invalid_credentials' } });
  });

  it('resetPassword changes the hash and kills sessions', async () => {
    const admin = principal(await seedUser(env, 'root', 'admin'));
    const bob = await seedUser(env, 'bob');
    await login(env.deps, { login: 'bob', password: PW, ip: 'a' });
    const r = await resetPassword(env.deps, {
      principal: admin,
      userId: bob.id,
      password: 'brand-new-password',
    });
    expect(r.ok).toBe(true);
    expect(env.sessions.rows).toHaveLength(0);
    expect(
      (await login(env.deps, { login: 'bob', password: 'brand-new-password', ip: 'a' })).ok,
    ).toBe(true);
    expect(env.audit.map((a) => a.action)).toContain('user.reset_password');
    expect(
      await resetPassword(env.deps, { principal: admin, userId: bob.id, password: 'x' }),
    ).toMatchObject({ ok: false, error: { code: 'weak_password' } });
    expect(
      await resetPassword(env.deps, { principal: admin, userId: 'nope', password: PW }),
    ).toMatchObject({ ok: false, error: { code: 'not_found' } });
  });

  it('resetPassword revokes the user API tokens', async () => {
    const admin = principal(await seedUser(env, 'root', 'admin'));
    const bob = await seedUser(env, 'bob');
    const t = await createToken(env.deps, { principal: principal(bob), name: 'ci' });
    await resetPassword(env.deps, {
      principal: admin,
      userId: bob.id,
      password: 'brand-new-password',
    });
    expect(await authenticateToken(env.deps, { token: t.token, ip: 'a' })).toMatchObject({
      ok: false,
      error: { code: 'invalid_token' },
    });
  });

  it('setDisabled(true) revokes the user API tokens, so re-enabling does not resurrect them', async () => {
    const admin = principal(await seedUser(env, 'root', 'admin'));
    const bob = await seedUser(env, 'bob');
    const t = await createToken(env.deps, { principal: principal(bob), name: 'ci' });
    await setDisabled(env.deps, { principal: admin, userId: bob.id, disabled: true });
    await setDisabled(env.deps, { principal: admin, userId: bob.id, disabled: false });
    expect(await authenticateToken(env.deps, { token: t.token, ip: 'a' })).toMatchObject({
      ok: false,
      error: { code: 'invalid_token' },
    });
  });

  it('setDisabled disables, kills sessions and audits', async () => {
    const admin = principal(await seedUser(env, 'root', 'admin'));
    const bob = await seedUser(env, 'bob');
    await login(env.deps, { login: 'bob', password: PW, ip: 'a' });
    expect(
      (await setDisabled(env.deps, { principal: admin, userId: bob.id, disabled: true })).ok,
    ).toBe(true);
    expect(bob.disabled).toBe(true);
    expect(env.sessions.rows).toHaveLength(0);
    expect(env.audit.map((a) => a.action)).toContain('user.disable');
    expect(
      await setDisabled(env.deps, { principal: admin, userId: 'nope', disabled: true }),
    ).toMatchObject({ ok: false, error: { code: 'not_found' } });
  });

  it('an admin cannot disable themselves', async () => {
    const root = await seedUser(env, 'root', 'admin');
    expect(
      await setDisabled(env.deps, { principal: principal(root), userId: root.id, disabled: true }),
    ).toMatchObject({ ok: false, error: { code: 'forbidden' } });
  });
});

describe('bootstrapAdmin', () => {
  it('creates the first admin', async () => {
    const r = await bootstrapAdmin(env.deps, { login: 'root', password: PW });
    expect(r).toEqual({ ok: true, value: true });
    expect(env.users.rows[0]).toMatchObject({ login: 'root', role: 'admin' });
    expect(env.audit.map((a) => a.action)).toContain('user.create');
  });

  it('does nothing when users exist', async () => {
    await seedUser(env, 'alice');
    const r = await bootstrapAdmin(env.deps, { login: 'root', password: PW });
    expect(r).toEqual({ ok: true, value: false });
    expect(env.users.rows).toHaveLength(1);
  });

  it('rejects a weak password', async () => {
    expect(await bootstrapAdmin(env.deps, { login: 'root', password: 'x' })).toMatchObject({
      ok: false,
      error: { code: 'weak_password' },
    });
  });
});

describe('bootstrapAdmin atomicity', () => {
  it('two parallel calls create exactly one admin', async () => {
    const rs = await Promise.all([
      bootstrapAdmin(env.deps, { login: 'a', password: PW }),
      bootstrapAdmin(env.deps, { login: 'b', password: PW }),
    ]);
    expect(rs.filter((r) => r.ok && r.value)).toHaveLength(1);
    expect(rs.every((r) => r.ok)).toBe(true);
    expect(env.users.rows).toHaveLength(1);
    expect(env.audit.filter((a) => a.action === 'user.create')).toHaveLength(1);
  });
});

describe('limiter audit throttling', () => {
  it('audits a rate_limited rejection once per IP per window', async () => {
    await repeat(25, (i) =>
      login(env.deps, { login: `u${i}`, password: 'whatever-pass-1', ip: '9.9.9.9' }),
    );
    const limited = () =>
      env.audit.filter((a) => a.meta?.['reason'] === 'rate_limited' && a.meta['ip'] === '9.9.9.9');
    expect(limited()).toHaveLength(1);
    env.time.now = new Date(env.time.now.getTime() + 16 * 60_000);
    await login(env.deps, { login: 'u1', password: 'whatever-pass-1', ip: '9.9.9.9' });
    // window passed: the limiter fake still blocks the IP, so a new record is allowed
    expect(limited()).toHaveLength(2);
  });

  it('audits a locked rejection once per login per window', async () => {
    await seedUser(env, 'alice');
    await repeat(5, (i) =>
      login(env.deps, { login: 'alice', password: 'bad-bad-bad-bad', ip: `ip${i}` }),
    );
    await repeat(4, (i) => login(env.deps, { login: 'alice', password: PW, ip: `jp${i}` }));
    expect(env.audit.filter((a) => a.meta?.['reason'] === 'locked')).toHaveLength(1);
  });
});

describe('operator (CLI) access', () => {
  it('actAs resolves a login to a cli principal, case-insensitively', async () => {
    const u = await seedUser(env, 'alice', 'admin');
    expect(await actAs(env.deps, 'ALICE')).toEqual({
      ok: true,
      value: { userId: u.id, login: 'alice', role: 'admin', via: 'cli' },
    });
  });

  it('actAs rejects an unknown or disabled user', async () => {
    expect(await actAs(env.deps, 'ghost')).toMatchObject({
      ok: false,
      error: { code: 'not_found' },
    });
    const u = await seedUser(env, 'bob');
    await env.users.setDisabled(u.id, true);
    expect(await actAs(env.deps, 'bob')).toMatchObject({ ok: false, error: { code: 'disabled' } });
  });

  it('createToken records via=cli in the audit meta for a cli principal only', async () => {
    const u = await seedUser(env, 'alice', 'admin');
    await createToken(env.deps, { principal: { ...principal(u), via: 'cli' }, name: 'a' });
    await createToken(env.deps, { principal: principal(u), name: 'b' });
    const creates = env.audit.filter((a) => a.action === 'token.create');
    expect(creates[0]?.meta).toMatchObject({ via: 'cli' });
    expect(creates[1]?.meta).not.toHaveProperty('via');
  });

  it('provisionUser creates a user without a principal and audits it as the system', async () => {
    const r = await provisionUser(env.deps, { login: 'carol', password: PW, role: 'member' });
    expect(r.ok).toBe(true);
    expect(env.users.rows.at(-1)).toMatchObject({ login: 'carol', role: 'member' });
    expect(env.audit.at(-1)).toMatchObject({ actorId: null, action: 'user.create' });
  });

  it('provisionUser rejects a taken login and a weak password', async () => {
    await seedUser(env, 'carol');
    expect(
      await provisionUser(env.deps, { login: 'carol', password: PW, role: 'member' }),
    ).toMatchObject({ ok: false, error: { code: 'user_exists' } });
    expect(
      await provisionUser(env.deps, { login: 'dave', password: 'x', role: 'admin' }),
    ).toMatchObject({ ok: false, error: { code: 'weak_password' } });
  });
});
