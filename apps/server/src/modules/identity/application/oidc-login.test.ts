import { beforeEach, describe, expect, it } from 'vite-plus/test';
import { idpDown, makeEnv, seedUser, type TestEnv } from '../../../../test/identity/fakes.ts';
import type { OidcClaims } from '../domain/user.ts';
import { completeSsoLogin, startSsoLogin } from './oidc-login.ts';
import { authenticateSession } from './sessions.ts';

let env: TestEnv;
beforeEach(() => {
  env = makeEnv({ sso: true });
});

const claims = (over: Partial<OidcClaims> = {}): OidcClaims => ({
  sub: 'sub-1',
  preferredUsername: 'Anna',
  email: 'anna@example.com',
  groups: ['skills-users'],
  ...over,
});

async function started(returnTo = '/skills') {
  const r = await startSsoLogin(env.deps, { returnTo });
  if (!r.ok) throw r.error;
  return r.value;
}

async function signIn(c: OidcClaims, returnTo = '/skills') {
  env.oidc.claims = c;
  const { state } = await started(returnTo);
  return completeSsoLogin(env.deps, { state, code: 'code-1', iss: 'https://idp', ip: 'ip' });
}

const actions = () => env.audit.map((a) => a.action);

describe('startSsoLogin', () => {
  it('remembers the attempt and sends a PKCE S256 challenge, state and nonce', async () => {
    const { url, state } = await started('/tokens');
    expect(url.searchParams.get('state')).toBe(state);
    expect(url.searchParams.get('nonce')).toBeTruthy();
    const [pending] = env.pendingLogins.rows;
    expect(pending).toMatchObject({ state, returnTo: '/tokens' });
    expect(pending?.expiresAt.getTime()).toBe(env.time.now.getTime() + 10 * 60_000);
    expect(env.oidc.lastChallenge).toBe(env.deps.sha256.base64url(pending?.codeVerifier ?? ''));
  });

  it('turns an off-site returnTo into /', async () => {
    await started('https://evil.example/');
    await started('//evil');
    expect(env.pendingLogins.rows.map((p) => p.returnTo)).toEqual(['/', '/']);
  });

  it('idp_unavailable, and nothing remembered, when the provider is down', async () => {
    env.oidc.startError = idpDown();
    const r = await startSsoLogin(env.deps, { returnTo: '/' });
    expect(r).toMatchObject({ ok: false, error: { code: 'idp_unavailable' } });
    expect(env.pendingLogins.rows).toEqual([]);
  });

  it('a start error that is not about the provider propagates', async () => {
    env.oidc.startError = new Error('bug');
    await expect(startSsoLogin(env.deps, { returnTo: '/' })).rejects.toThrow('bug');
  });

  it('not_found without single sign-on', async () => {
    env = makeEnv();
    expect(await startSsoLogin(env.deps, { returnTo: '/' })).toMatchObject({
      ok: false,
      error: { code: 'not_found' },
    });
    expect(await completeSsoLogin(env.deps, { state: 's', code: 'c', ip: 'ip' })).toMatchObject({
      ok: false,
      error: { code: 'not_found' },
    });
  });
});

describe('completeSsoLogin', () => {
  it('creates a member for the login group and opens a session', async () => {
    const r = await signIn(claims());
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.returnTo).toBe('/skills');
    const [user] = env.users.rows;
    expect(user).toMatchObject({
      login: 'anna',
      oidcSub: 'sub-1',
      email: 'anna@example.com',
      groups: ['skills-users'],
      role: 'member',
      passwordHash: null,
      lastLoginAt: env.time.now,
    });
    expect(await authenticateSession(env.deps, { sessionId: r.value.sessionId })).toMatchObject({
      login: 'anna',
      role: 'member',
      via: 'session',
    });
    expect(env.audit).toContainEqual(
      expect.objectContaining({
        action: 'user.create',
        meta: expect.objectContaining({ method: 'sso' }),
      }),
    );
    expect(env.audit).toContainEqual({
      actorId: user?.id,
      action: 'auth.login',
      meta: { method: 'sso', ip: 'ip' },
    });
    // PKCE verifier, nonce and iss went to the provider
    expect(env.oidc.exchanges[0]).toMatchObject({ code: 'code-1', iss: 'https://idp' });
  });

  it('passes no iss when the provider sent none', async () => {
    env.oidc.claims = claims();
    const { state } = await started();
    await completeSsoLogin(env.deps, { state, code: 'c', ip: 'ip' });
    expect(env.oidc.exchanges[0]).not.toHaveProperty('iss');
  });

  it('makes the admin group admins and re-syncs the role on every login', async () => {
    await signIn(claims({ groups: ['skills-admins'] }));
    expect(env.users.rows[0]?.role).toBe('admin');
    await signIn(claims({ groups: ['skills-users'], email: null }));
    expect(env.users.rows).toHaveLength(1);
    expect(env.users.rows[0]).toMatchObject({ role: 'member', email: null });
    expect(env.audit).toContainEqual(
      expect.objectContaining({
        action: 'user.role_sync',
        meta: { from: 'admin', to: 'member', method: 'sso' },
      }),
    );
  });

  it('a linked password user keeps id, login and password; role follows the groups', async () => {
    const bob = await seedUser(env, 'bob', 'member');
    await env.users.setOidcSub(bob.id, 'sub-bob');
    const r = await signIn(
      claims({ sub: 'sub-bob', preferredUsername: 'robert', groups: ['skills-admins'] }),
    );
    expect(r.ok).toBe(true);
    expect(env.users.rows).toHaveLength(1);
    expect(env.users.rows[0]).toMatchObject({ id: bob.id, login: 'bob', role: 'admin' });
    expect(env.users.rows[0]?.passwordHash).not.toBeNull();
  });

  it('derives a unique login: anna, anna-2, anna-3', async () => {
    await seedUser(env, 'anna');
    await signIn(claims({ sub: 's2' }));
    await signIn(claims({ sub: 's3' }));
    expect(env.users.rows.map((u) => u.login)).toEqual(['anna', 'anna-2', 'anna-3']);
  });

  it('refuses people outside the allowed groups and creates nobody', async () => {
    const r = await signIn(claims({ groups: ['family'] }));
    expect(r).toMatchObject({ ok: false, error: { code: 'not_allowed' } });
    expect(env.users.rows).toEqual([]);
    expect(env.sessions.rows).toEqual([]);
    expect(env.audit).toContainEqual({
      actorId: null,
      action: 'auth.login_failed',
      meta: { reason: 'not_allowed', method: 'sso', ip: 'ip', sub: 'sub-1' },
    });
  });

  it('refuses a disabled user', async () => {
    await signIn(claims());
    const [user] = env.users.rows;
    if (!user) throw new Error('no user');
    user.disabled = true;
    const sessions = env.sessions.rows.length;
    const r = await signIn(claims({ groups: ['skills-admins'] }));
    expect(r).toMatchObject({ ok: false, error: { code: 'disabled' } });
    expect(env.sessions.rows).toHaveLength(sessions);
    expect(user.role).toBe('member');
    expect(env.audit.at(-1)).toMatchObject({
      actorId: user.id,
      action: 'auth.login_failed',
      meta: { reason: 'disabled', method: 'sso' },
    });
  });

  it('accepts a state only once, and not after it expired', async () => {
    env.oidc.claims = claims();
    const { state } = await started();
    expect((await completeSsoLogin(env.deps, { state, code: 'c', ip: 'ip' })).ok).toBe(true);
    expect(await completeSsoLogin(env.deps, { state, code: 'c', ip: 'ip' })).toMatchObject({
      ok: false,
      error: { code: 'invalid_state' },
    });

    const late = await started();
    env.time.now = new Date(env.time.now.getTime() + 10 * 60_000);
    expect(
      await completeSsoLogin(env.deps, { state: late.state, code: 'c', ip: 'ip' }),
    ).toMatchObject({ ok: false, error: { code: 'invalid_state' } });
  });

  it('a rejected code exchange is invalid_state and audited', async () => {
    const { state } = await started();
    env.oidc.exchangeError = new Error('invalid_grant');
    const r = await completeSsoLogin(env.deps, { state, code: 'c', ip: 'ip' });
    expect(r).toMatchObject({ ok: false, error: { code: 'invalid_state' } });
    expect(env.audit.at(-1)).toMatchObject({
      action: 'auth.login_failed',
      meta: { reason: 'exchange_failed', method: 'sso' },
    });
  });

  it('a provider outage during the exchange is idp_unavailable, not audited', async () => {
    const { state } = await started();
    env.oidc.exchangeError = idpDown();
    const r = await completeSsoLogin(env.deps, { state, code: 'c', ip: 'ip' });
    expect(r).toMatchObject({ ok: false, error: { code: 'idp_unavailable' } });
    expect(actions()).toEqual([]);
  });

  it('a concurrent first login of the same person lands on the user the other one created', async () => {
    env.users.beforeInsertSso = () => {
      env.users.beforeInsertSso = null;
      env.users.rows.push({
        id: 'other',
        login: 'anna',
        passwordHash: null,
        role: 'member',
        disabled: false,
        createdAt: env.time.now,
        oidcSub: 'sub-1',
        email: null,
        groups: [],
        lastLoginAt: null,
      });
    };
    const r = await signIn(claims({ groups: ['skills-admins'] }));
    expect(r.ok).toBe(true);
    expect(env.users.rows).toHaveLength(1);
    expect(env.users.rows[0]).toMatchObject({ id: 'other', role: 'admin' });
  });

  it('…and is refused if that user was disabled in the meantime', async () => {
    env.users.beforeInsertSso = () => {
      env.users.beforeInsertSso = null;
      env.users.rows.push({
        id: 'other',
        login: 'anna',
        passwordHash: null,
        role: 'member',
        disabled: true,
        createdAt: env.time.now,
        oidcSub: 'sub-1',
        email: null,
        groups: [],
        lastLoginAt: null,
      });
    };
    expect(await signIn(claims())).toMatchObject({ ok: false, error: { code: 'disabled' } });
  });

  it('gives up after 100 taken logins', async () => {
    await Promise.all(
      Array.from({ length: 100 }, (_, i) => seedUser(env, i === 0 ? 'anna' : `anna-${i + 1}`)),
    );
    await expect(signIn(claims())).rejects.toThrow(/no free login/);
  });
});
