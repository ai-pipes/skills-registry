import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vite-plus/test';
import {
  authenticateSession,
  authenticateToken,
  bootstrapAdmin,
  createPgIdentity,
  createToken,
  login as logIn,
  resetPassword,
  revokeToken,
  setDisabled,
  type IdentityDeps,
} from '../../src/modules/identity/index.ts';
import { PgAuditLog } from '../../src/platform/audit.ts';
import { startPg, truncateAll } from '../pg.ts';

let pg: Awaited<ReturnType<typeof startPg>>;
let deps: IdentityDeps;
let time: { now: Date };

beforeAll(async () => {
  pg = await startPg();
});
afterAll(async () => {
  await pg.stop();
});
beforeEach(async () => {
  await truncateAll(pg.sql);
  time = { now: new Date() };
  deps = {
    ...createPgIdentity(pg.sql),
    sso: null,
    audit: new PgAuditLog(pg.sql),
    clock: { now: () => time.now },
  };
});

const PW = 'correct-horse-battery';

describe('identity (postgres, real argon2)', () => {
  it('bootstrap, login, session, token, revoke round-trip', async () => {
    expect(await bootstrapAdmin(deps, { login: 'Root', password: PW })).toEqual({
      ok: true,
      value: true,
    });
    expect(await bootstrapAdmin(deps, { login: 'other', password: PW })).toEqual({
      ok: true,
      value: false,
    });
    const [row] = await pg.sql<
      { password_hash: string }[]
    >`select password_hash from identity.users`;
    expect(row?.password_hash.startsWith('$argon2id$')).toBe(true);

    const bad = await logIn(deps, { login: 'root', password: 'wrong-wrong-wrong', ip: 'ip' });
    expect(bad).toMatchObject({ ok: false, error: { code: 'invalid_credentials' } });

    const r = await logIn(deps, { login: 'ROOT', password: PW, ip: 'ip' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const p = await authenticateSession(deps, { sessionId: r.value.sessionId });
    expect(p).toMatchObject({ login: 'Root', role: 'admin', via: 'session' });
    if (!p) return;

    const stored = await pg.sql`select * from identity.sessions`;
    expect(JSON.stringify(stored)).not.toContain(r.value.sessionId);

    const t = await createToken(deps, { principal: p, name: 'ci' });
    const dump = JSON.stringify(await pg.sql`select * from identity.api_tokens`);
    expect(dump).not.toContain(t.token);
    const viaToken = await authenticateToken(deps, { token: t.token, ip: 'ip' });
    expect(viaToken).toMatchObject({ ok: true, value: { login: 'Root', via: 'token' } });
    const [used] = await pg.sql`select last_used_at from identity.api_tokens`;
    expect(used?.last_used_at).toBeInstanceOf(Date);

    expect((await revokeToken(deps, { principal: p, id: t.id })).ok).toBe(true);
    expect(await authenticateToken(deps, { token: t.token, ip: 'ip' })).toMatchObject({
      ok: false,
      error: { code: 'invalid_token' },
    });
    expect(await revokeToken(deps, { principal: p, id: 'not-a-uuid' })).toMatchObject({
      ok: false,
      error: { code: 'not_found' },
    });

    const actions = await pg.sql<{ action: string }[]>`select action from platform.audit_log`;
    expect(actions.map((a) => a.action)).toEqual(
      expect.arrayContaining([
        'user.create',
        'auth.login_failed',
        'auth.login',
        'token.create',
        'token.revoke',
      ]),
    );
  });

  it('parallel bootstrapAdmin calls create exactly one admin', async () => {
    const rs = await Promise.all(
      ['a', 'b', 'c', 'd'].map((login) => bootstrapAdmin(deps, { login, password: PW })),
    );
    expect(rs.filter((r) => r.ok && r.value)).toHaveLength(1);
    const [row] = await pg.sql<{ n: number }[]>`select count(*)::int as n from identity.users`;
    expect(row?.n).toBe(1);
  });

  it('expires idle sessions (last_seen_at shifted in SQL)', async () => {
    await bootstrapAdmin(deps, { login: 'root', password: PW });
    const r = await logIn(deps, { login: 'root', password: PW, ip: 'ip' });
    if (!r.ok) throw new Error('login failed');
    expect(await authenticateSession(deps, { sessionId: r.value.sessionId })).not.toBeNull();

    await pg.sql`update identity.sessions set last_seen_at = now() - interval '13 hours'`;
    expect(await authenticateSession(deps, { sessionId: r.value.sessionId })).toBeNull();
    const left = await pg.sql`select 1 from identity.sessions`;
    expect(left).toHaveLength(0);
  });

  it('expires sessions absolutely (expires_at shifted in SQL)', async () => {
    await bootstrapAdmin(deps, { login: 'root', password: PW });
    const r = await logIn(deps, { login: 'root', password: PW, ip: 'ip' });
    if (!r.ok) throw new Error('login failed');
    await pg.sql`update identity.sessions set expires_at = now() - interval '1 second'`;
    expect(await authenticateSession(deps, { sessionId: r.value.sessionId })).toBeNull();
  });

  it('resetPassword and disabling revoke API tokens in the database', async () => {
    await bootstrapAdmin(deps, { login: 'root', password: PW });
    const admin = await deps.users.findByLogin('root');
    const bob = await deps.users.insert({
      login: 'bob',
      passwordHash: 'h',
      role: 'member',
      createdAt: new Date(),
    });
    if (!admin || !bob) throw new Error('setup failed');
    const ap = { userId: admin.id, login: 'root', role: 'admin' as const, via: 'session' as const };
    const bp = { userId: bob.id, login: 'bob', role: 'member' as const, via: 'session' as const };
    const t1 = await createToken(deps, { principal: bp, name: 'a' });
    const t2 = await createToken(deps, { principal: bp, name: 'b' });
    expect(
      (await resetPassword(deps, { principal: ap, userId: bob.id, password: 'brand-new-password' }))
        .ok,
    ).toBe(true);
    const after = await Promise.all(
      [t1, t2].map((t) => authenticateToken(deps, { token: t.token, ip: 'ip' })),
    );
    for (const r of after) {
      expect(r).toMatchObject({ ok: false, error: { code: 'invalid_token' } });
    }
    const t3 = await createToken(deps, { principal: bp, name: 'c' });
    await setDisabled(deps, { principal: ap, userId: bob.id, disabled: true });
    await setDisabled(deps, { principal: ap, userId: bob.id, disabled: false });
    expect(await authenticateToken(deps, { token: t3.token, ip: 'ip' })).toMatchObject({
      ok: false,
      error: { code: 'invalid_token' },
    });
  });

  it('enforces unique logins case-insensitively and survives concurrent creation', async () => {
    const inserts = await Promise.all(
      ['Dup', 'dup', 'DUP'].map((login) =>
        deps.users.insert({ login, passwordHash: 'h', role: 'member', createdAt: new Date() }),
      ),
    );
    expect(inserts.filter((u) => u !== null)).toHaveLength(1);
  });

  it('tokens and sessions round-trip through repositories', async () => {
    const u = await deps.users.insert({
      login: 'u',
      passwordHash: 'h',
      role: 'member',
      createdAt: new Date(),
    });
    if (!u) throw new Error('insert failed');
    const t = await deps.tokens.insert({
      userId: u.id,
      name: 'n',
      prefix: 'sk_abcdefg',
      hash: 'a'.repeat(64),
      createdAt: new Date(),
    });
    expect(await deps.tokens.findByHash('a'.repeat(64))).toEqual(t);
    expect(await deps.tokens.listByUser(u.id)).toEqual([t]);
    expect(await deps.users.findById('nope')).toBeNull();
    expect(await deps.users.count()).toBe(1);
    expect(await deps.users.setDisabled(u.id, true)).toBe(true);
    expect((await deps.users.findById(u.id))?.disabled).toBe(true);
    expect(await deps.users.setPasswordHash('nope', 'x')).toBe(false);
  });
});
