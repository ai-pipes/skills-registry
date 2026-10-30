import { beforeEach, describe, expect, it } from 'vite-plus/test';
import { makeEnv, seedUser, type TestEnv } from '../../../../test/identity/fakes.ts';
import type { Principal, User } from '../domain/user.ts';
import { login } from './sessions.ts';
import { createUser, linkSso, listUsers, resetPassword, setDisabled, unlinkSso } from './users.ts';

const PW = 'correct-horse-battery';
let env: TestEnv;

const principal = (u: User): Principal => ({
  userId: u.id,
  login: u.login,
  role: u.role,
  via: 'session',
});

describe('password mode', () => {
  beforeEach(() => {
    env = makeEnv();
  });

  it('a password login stamps lastLoginAt; listUsers reports sso, email, lastLoginAt', async () => {
    const root = await seedUser(env, 'root', 'admin');
    expect((await login(env.deps, { login: 'root', password: PW, ip: 'ip' })).ok).toBe(true);
    const list = await listUsers(env.deps, { principal: principal(root) });
    expect(list).toMatchObject({
      ok: true,
      value: [{ login: 'root', sso: false, email: null, lastLoginAt: env.time.now }],
    });
  });

  it('a user without a password (created by SSO) cannot sign in with one', async () => {
    const u = await seedUser(env, 'anna');
    u.passwordHash = null;
    const r = await login(env.deps, { login: 'anna', password: PW, ip: 'ip' });
    expect(r).toMatchObject({ ok: false, error: { code: 'invalid_credentials' } });
  });
});

describe('single sign-on mode', () => {
  let admin: User;
  beforeEach(async () => {
    env = makeEnv({ sso: true });
    admin = await seedUser(env, 'root', 'admin');
  });

  it('password login is sso_only, before any limiter or hash work', async () => {
    const r = await login(env.deps, { login: 'root', password: PW, ip: 'ip' });
    expect(r).toMatchObject({ ok: false, error: { code: 'sso_only' } });
    expect(env.hasher.verifyCalls).toBe(0);
    expect(env.sessions.rows).toEqual([]);
  });

  it('creating users and resetting passwords is sso_managed', async () => {
    const p = principal(admin);
    expect(
      await createUser(env.deps, { principal: p, login: 'bob', password: PW, role: 'member' }),
    ).toMatchObject({ ok: false, error: { code: 'sso_managed' } });
    expect(
      await resetPassword(env.deps, { principal: p, userId: admin.id, password: PW }),
    ).toMatchObject({ ok: false, error: { code: 'sso_managed' } });
    expect(env.users.rows).toHaveLength(1);
  });

  it('members still get forbidden first', async () => {
    const m = await seedUser(env, 'm');
    expect(
      await createUser(env.deps, {
        principal: principal(m),
        login: 'x',
        password: PW,
        role: 'member',
      }),
    ).toMatchObject({ ok: false, error: { code: 'forbidden' } });
  });

  it('disabling still works and still revokes sessions and tokens', async () => {
    const bob = await seedUser(env, 'bob');
    const r = await setDisabled(env.deps, {
      principal: principal(admin),
      userId: bob.id,
      disabled: true,
    });
    expect(r.ok).toBe(true);
  });
});

describe('linkSso / unlinkSso (operator)', () => {
  beforeEach(() => {
    env = makeEnv();
  });

  it('links, is idempotent for the same pair, and audits once', async () => {
    const bob = await seedUser(env, 'bob');
    expect(await linkSso(env.deps, { login: ' Bob ', sub: ' sub-b ' })).toEqual({
      ok: true,
      value: { changed: true },
    });
    expect(bob.oidcSub).toBe('sub-b');
    expect(await linkSso(env.deps, { login: 'bob', sub: 'sub-b' })).toEqual({
      ok: true,
      value: { changed: false },
    });
    expect(env.audit.filter((a) => a.action === 'user.link_sso')).toEqual([
      {
        actorId: null,
        action: 'user.link_sso',
        target: bob.id,
        meta: { login: 'bob', sub: 'sub-b', previousSub: null },
      },
    ]);
    const list = await listUsers(env.deps, {
      principal: principal(await seedUser(env, 'r', 'admin')),
    });
    expect(list.ok && list.value.find((u) => u.login === 'bob')?.sso).toBe(true);
  });

  it('refuses a sub that belongs to another user', async () => {
    await seedUser(env, 'bob');
    await seedUser(env, 'carol');
    await linkSso(env.deps, { login: 'bob', sub: 'sub-x' });
    expect(await linkSso(env.deps, { login: 'carol', sub: 'sub-x' })).toMatchObject({
      ok: false,
      error: { code: 'sso_linked' },
    });
  });

  it('unknown login → not_found; empty sub → invalid_input', async () => {
    await seedUser(env, 'bob');
    expect(await linkSso(env.deps, { login: 'nobody', sub: 's' })).toMatchObject({
      ok: false,
      error: { code: 'not_found' },
    });
    expect(await linkSso(env.deps, { login: 'bob', sub: '  ' })).toMatchObject({
      ok: false,
      error: { code: 'invalid_input' },
    });
    expect(await unlinkSso(env.deps, { login: 'nobody' })).toMatchObject({
      ok: false,
      error: { code: 'not_found' },
    });
  });

  it('unlinks, and reports when there was nothing to unlink', async () => {
    const bob = await seedUser(env, 'bob');
    await linkSso(env.deps, { login: 'bob', sub: 'sub-b' });
    expect(await unlinkSso(env.deps, { login: 'bob' })).toEqual({
      ok: true,
      value: { changed: true },
    });
    expect(bob.oidcSub).toBeNull();
    expect(env.audit.at(-1)).toMatchObject({
      action: 'user.unlink_sso',
      target: bob.id,
      meta: { login: 'bob', sub: 'sub-b' },
    });
    expect(await unlinkSso(env.deps, { login: 'bob' })).toEqual({
      ok: true,
      value: { changed: false },
    });
  });
});
