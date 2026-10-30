import { createHash, randomBytes } from 'node:crypto';
import { AuthConfigResponse, CreatedToken, MeResponse, UserSummary } from '@skills/contracts';
import type { Hono } from 'hono';
import { z } from 'zod';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vite-plus/test';
import { OpenidProvider, provisionUser } from '../../src/modules/identity/index.ts';
import { runCli } from '../../src/platform/cli-commands.ts';
import type { Config } from '../../src/platform/config.ts';
import { buildContainer, type Container, ssoRedirectUri } from '../../src/platform/container.ts';
import { createHttpApp } from '../../src/platform/http/app.ts';
import type { AppEnv } from '../../src/platform/http/env.ts';
import { createLogger } from '../../src/platform/logger.ts';
import { FakeEmbedder } from '../fakes/fake-embedder.ts';
import { startPg, truncateAll } from '../pg.ts';
import { type FakeClaims, FakeIdp } from './fake-idp.ts';

const ORIGIN = 'http://skills.test';
const PW = 'correct-horse-battery';

let pg: Awaited<ReturnType<typeof startPg>>;
let idp: FakeIdp;
let container: Container;
let app: Hono<AppEnv>;
let logLines: string[];
const warnings: { fields: object; msg: string }[] = [];

function configFor(overrides: Partial<Config> = {}): Config {
  return {
    port: 3000,
    databaseUrl: 'postgres://unused',
    publicUrl: `${ORIGIN}/`,
    allowedHosts: [],
    trustProxy: false,
    trustProxyHops: 1,
    cookieSecure: false,
    embedder: 'local',
    modelDir: '/nonexistent',
    searchMinSimilarity: 0.3,
    logLevel: 'info',
    oidc: {
      issuer: idp.issuer,
      clientId: idp.clientId,
      clientSecret: idp.clientSecret,
      loginGroup: 'skills-users',
      adminGroup: 'skills-admins',
      scopes: 'openid profile email groups',
      groupsClaim: 'groups',
      // The fake provider listens on plain http.
      allowInsecure: true,
    },
    ...overrides,
  };
}

function providerFor(config: Config): OpenidProvider {
  const oidc = config.oidc;
  if (!oidc) throw new Error('no oidc config');
  return new OpenidProvider({
    issuer: oidc.issuer,
    clientId: oidc.clientId,
    clientSecret: oidc.clientSecret,
    redirectUri: ssoRedirectUri(config.publicUrl),
    allowInsecure: oidc.allowInsecure,
    logger: { warn: (fields, msg) => warnings.push({ fields, msg }) },
  });
}

function makeApp(overrides: Partial<Config> = {}, opts: { sso?: boolean } = {}) {
  const { oidc: _unused, ...withoutOidc } = configFor(overrides);
  const config: Config = opts.sso === false ? withoutOidc : configFor(overrides);
  const logger = createLogger('info', { write: (line: string) => logLines.push(line) });
  const c = buildContainer(config, pg.sql, {
    embedder: new FakeEmbedder(),
    logger,
    ...(config.oidc ? { oidc: providerFor(config) } : {}),
  });
  return { container: c, app: createHttpApp(c, { remoteAddress: () => '192.0.2.1' }).app };
}

beforeAll(async () => {
  pg = await startPg();
  idp = new FakeIdp();
  await idp.start();
});
afterAll(async () => {
  await idp.stop();
  await pg.stop();
});
beforeEach(async () => {
  await truncateAll(pg.sql);
  logLines = [];
  warnings.length = 0;
  ({ container, app } = makeApp());
});

const setCookies = (res: Response): string[] => res.headers.getSetCookie();

function cookiePair(res: Response, name: string): string {
  return (setCookies(res).find((c) => c.startsWith(`${name}=`)) ?? '').split(';')[0] ?? '';
}

function sessionOf(res: Response): string {
  const pair = cookiePair(res, 'sr_session');
  expect(pair).toMatch(/^sr_session=.+/);
  return pair;
}

const hasSession = (res: Response) => setCookies(res).some((c) => c.startsWith('sr_session='));

/** Walks the browser through the whole flow; returns the callback response. */
async function signIn(claims: FakeClaims, returnTo = '/skills', target = app) {
  const start = await target.request(
    `/api/auth/sso/login?returnTo=${encodeURIComponent(returnTo)}`,
  );
  expect(start.status).toBe(302);
  const location = new URL(start.headers.get('location') ?? '');
  expect(location.origin).toBe(idp.issuer);
  expect(location.searchParams.get('redirect_uri')).toBe(`${ORIGIN}/api/auth/sso/callback`);
  const code = idp.authorize(location, claims);
  const state = location.searchParams.get('state') ?? '';
  const binding = cookiePair(start, 'sr_login');
  expect(binding).toMatch(/^sr_login=.+/);
  const callback = await target.request(
    `/api/auth/sso/callback?code=${code}&state=${encodeURIComponent(state)}&iss=${encodeURIComponent(idp.issuer)}`,
    { headers: { cookie: binding } },
  );
  // The one-time binding cookie is cleared whatever the outcome.
  const cleared = setCookies(callback).find((c) => c.startsWith('sr_login=')) ?? '';
  expect(cleared).toMatch(/^sr_login=;/);
  expect(cleared).toMatch(/Max-Age=0/i);
  return { callback, code, state, binding };
}

async function signedIn(claims: FakeClaims): Promise<string> {
  const { callback } = await signIn(claims);
  expect(callback.headers.get('location')).toBe('/skills');
  return sessionOf(callback);
}

const call = (method: string, path: string, cookie: string, body?: unknown) =>
  app.request(path, {
    method,
    headers: { origin: ORIGIN, cookie, 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

async function users(): Promise<UserSummary[]> {
  const admin = await signedIn({ sub: 'sub-root', groups: ['skills-admins'] });
  return z.array(UserSummary).parse(await (await call('GET', '/api/users', admin)).json());
}

async function userCount(): Promise<number> {
  const rows = await pg.sql<{ n: number }[]>`select count(*)::int as n from identity.users`;
  return rows[0]?.n ?? -1;
}

async function cli(argv: string[]) {
  const out: string[] = [];
  const err: string[] = [];
  const code = await runCli(argv, container, {
    readStdin: async () => '',
    out: (line) => out.push(line),
    err: (line) => err.push(line),
  });
  return { code, out, err };
}

const anna: FakeClaims = {
  sub: 'sub-anna',
  preferred_username: 'Anna',
  email: 'anna@example.com',
  email_verified: true,
  groups: ['skills-users'],
};

/** One full attempt whose callback carries the given `iss` (null: none). */
async function attemptWithIss(iss: string | null): Promise<Response> {
  const start = await app.request('/api/auth/sso/login');
  const location = new URL(start.headers.get('location') ?? '');
  const code = idp.authorize(location, anna);
  const state = encodeURIComponent(location.searchParams.get('state') ?? '');
  const issPart = iss === null ? '' : `&iss=${encodeURIComponent(iss)}`;
  return app.request(`/api/auth/sso/callback?code=${code}&state=${state}${issPart}`, {
    headers: { cookie: cookiePair(start, 'sr_login') },
  });
}

describe('GET /api/auth/config (no session needed)', () => {
  it('answers sso with OIDC configured and password without', async () => {
    const sso = await app.request('/api/auth/config');
    expect(sso.status).toBe(200);
    expect(AuthConfigResponse.parse(await sso.json())).toEqual({ method: 'sso' });
    const plain = makeApp({}, { sso: false }).app;
    const pw = await plain.request('/api/auth/config');
    expect(AuthConfigResponse.parse(await pw.json())).toEqual({ method: 'password' });
  });
});

describe('single sign-on through the fake provider', () => {
  it('creates a member, sets the same session cookie as a password login and serves /me', async () => {
    const { callback } = await signIn(anna);
    expect(callback.status).toBe(302);
    expect(callback.headers.get('location')).toBe('/skills');
    const raw = setCookies(callback).find((c) => c.startsWith('sr_session=')) ?? '';
    expect(raw).toMatch(/HttpOnly/i);
    expect(raw).toMatch(/SameSite=Strict/i);
    expect(raw).toMatch(/Path=\//);
    const cookie = sessionOf(callback);
    const me = await app.request('/api/auth/me', { headers: { cookie } });
    expect(MeResponse.parse(await me.json())).toEqual({ login: 'anna', role: 'member' });

    const list = await users();
    expect(list.find((u) => u.login === 'anna')).toMatchObject({
      role: 'member',
      sso: true,
      email: 'anna@example.com',
      disabled: false,
    });
    expect(list.find((u) => u.login === 'anna')?.lastLoginAt).not.toBeNull();
    const [row] = await pg.sql<{ password_hash: string | null; groups: string[] }[]>`
      select password_hash, groups from identity.users where oidc_sub = 'sub-anna'`;
    expect(row).toEqual({ password_hash: null, groups: ['skills-users'] });

    const audit = await pg.sql<{ action: string; meta: Record<string, unknown> }[]>`
      select action, meta from platform.audit_log where action = 'auth.login'`;
    expect(audit[0]?.meta).toMatchObject({ method: 'sso' });
  });

  it('makes the admin group admins and re-syncs the role on every login', async () => {
    const admin = await signedIn({ ...anna, groups: ['skills-users', 'skills-admins'] });
    expect(
      MeResponse.parse(
        await (await app.request('/api/auth/me', { headers: { cookie: admin } })).json(),
      ),
    ).toEqual({ login: 'anna', role: 'admin' });
    const member = await signedIn(anna);
    expect(
      MeResponse.parse(
        await (await app.request('/api/auth/me', { headers: { cookie: member } })).json(),
      ),
    ).toEqual({ login: 'anna', role: 'member' });
    expect(await userCount()).toBe(1);
  });

  it('derives unique logins for new people', async () => {
    await provisionUser(container.identity, { login: 'anna', password: PW, role: 'member' });
    await signedIn(anna);
    await signedIn({
      sub: 'other',
      email: 'Anna@corp.example',
      email_verified: true,
      groups: ['skills-users'],
    });
    // An unverified email never names the account.
    await signedIn({ sub: 'Zed-Sub', email: 'root@corp.example', groups: ['skills-users'] });
    const logins = (
      await pg.sql<{ login: string }[]>`
      select login from identity.users order by created_at, login`
    ).map((r) => r.login);
    expect(logins.toSorted()).toEqual(['anna', 'anna-2', 'anna-3', 'zed-sub']);
  });

  it('refuses people outside the allowed groups and creates nobody', async () => {
    const { callback } = await signIn({ sub: 'x', groups: ['family'] });
    expect(callback.headers.get('location')).toBe('/login?loginError=not_allowed');
    expect(hasSession(callback)).toBe(false);
    expect(await userCount()).toBe(0);
    const failed = await pg.sql<{ meta: Record<string, unknown> }[]>`
      select meta from platform.audit_log where action = 'auth.login_failed'`;
    expect(failed[0]?.meta).toMatchObject({ reason: 'not_allowed', method: 'sso', sub: 'x' });
  });

  it('a disabled user is refused; disabling revokes their session', async () => {
    const memberCookie = await signedIn(anna);
    const adminCookie = await signedIn({ sub: 'sub-root', groups: ['skills-admins'] });
    const [row] = await pg.sql<{ id: string }[]>`
      select id from identity.users where oidc_sub = 'sub-anna'`;
    const off = await call('POST', `/api/users/${row?.id}/disable`, adminCookie, {
      disabled: true,
    });
    expect(off.status).toBe(204);
    expect((await app.request('/api/auth/me', { headers: { cookie: memberCookie } })).status).toBe(
      401,
    );
    const retry = await signIn(anna);
    expect(retry.callback.headers.get('location')).toBe('/login?loginError=disabled');
    expect(hasSession(retry.callback)).toBe(false);
  });

  it('keeps returnTo on this site and accepts a state only once', async () => {
    const { callback, code, state, binding } = await signIn(anna, 'https://evil.example/');
    expect(callback.headers.get('location')).toBe('/');
    const replay = await app.request(
      `/api/auth/sso/callback?code=${code}&state=${encodeURIComponent(state)}`,
      { headers: { cookie: binding } },
    );
    expect(replay.headers.get('location')).toBe('/login?loginError=invalid_state');
  });

  it('refuses a callback without the binding cookie, or with another attempt’s', async () => {
    const other = await app.request('/api/auth/sso/login');
    const otherBinding = cookiePair(other, 'sr_login');
    const start = await app.request('/api/auth/sso/login');
    const location = new URL(start.headers.get('location') ?? '');
    const code = idp.authorize(location, anna);
    const state = encodeURIComponent(location.searchParams.get('state') ?? '');
    const url = `/api/auth/sso/callback?code=${code}&state=${state}&iss=${encodeURIComponent(idp.issuer)}`;
    // Neither request consumes the attempt: the binding check comes first.
    const responses = await Promise.all(
      [{}, { cookie: otherBinding }].map(async (headers) => app.request(url, { headers })),
    );
    for (const res of responses) {
      expect(res.headers.get('location')).toBe('/login?loginError=invalid_state');
      expect(hasSession(res)).toBe(false);
    }
    expect(await userCount()).toBe(0);
  });

  it('refuses a wrong or missing iss (the provider advertises iss support)', async () => {
    for (const res of await Promise.all([
      attemptWithIss('https://evil.example'),
      attemptWithIss(null),
    ])) {
      expect(res.headers.get('location')).toBe('/login?loginError=invalid_state');
    }
    expect(await userCount()).toBe(0);
  });

  it('rejects an unknown state and a callback without parameters', async () => {
    const unknown = await app.request('/api/auth/sso/callback?code=c&state=nope', {
      headers: { cookie: 'sr_login=nope' },
    });
    expect(unknown.headers.get('location')).toBe('/login?loginError=invalid_state');
    const bare = await app.request('/api/auth/sso/callback');
    expect(bare.headers.get('location')).toBe('/login?loginError=invalid_state');
  });

  it('falls back to UserInfo when the ID token has no groups', async () => {
    idp.groupsOnlyInUserInfo = true;
    try {
      expect(await signedIn(anna)).toMatch(/^sr_session=/);
    } finally {
      idp.groupsOnlyInUserInfo = false;
    }
  });

  it('denies and logs a warning when UserInfo fails, without leaking tokens or claims', async () => {
    idp.groupsOnlyInUserInfo = true;
    idp.userinfoFails = true;
    try {
      const { callback } = await signIn(anna);
      expect(callback.headers.get('location')).toBe('/login?loginError=not_allowed');
    } finally {
      idp.groupsOnlyInUserInfo = false;
      idp.userinfoFails = false;
    }
    expect(warnings.map((w) => w.msg)).toEqual([
      'oidc userinfo failed; treating the person as having no groups',
    ]);
    const logged = JSON.stringify(warnings);
    expect(logged).not.toContain('access-');
    expect(logged).not.toContain('anna@example.com');
  });

  it('an unexpected failure redirects with loginError=internal and logs no message', async () => {
    const repo = container.identity.users;
    const original = repo.insertSso.bind(repo);
    repo.insertSso = () => Promise.reject(new Error('connection terminated: secret-detail'));
    try {
      const { callback } = await signIn(anna);
      expect(callback.headers.get('location')).toBe('/login?loginError=internal');
      expect(hasSession(callback)).toBe(false);
    } finally {
      repo.insertSso = original;
    }
    expect(logLines.join('\n')).toContain('auth: sso callback failed');
    expect(logLines.join('\n')).not.toContain('secret-detail');
  });

  it('marks the binding and session cookies Secure when COOKIE_SECURE is on', async () => {
    const secure = makeApp({ cookieSecure: true }).app;
    const { callback, binding } = await signIn(anna, '/skills', secure);
    expect(binding).toMatch(/^sr_login=/);
    expect(setCookies(callback).find((c) => c.startsWith('sr_session='))).toMatch(/Secure/i);
    const start = await secure.request('/api/auth/sso/login');
    const raw = setCookies(start).find((c) => c.startsWith('sr_login=')) ?? '';
    expect(raw).toMatch(/Secure/i);
    expect(raw).toMatch(/SameSite=Lax/i);
    expect(raw).toMatch(/HttpOnly/i);
    expect(raw).toMatch(/Path=\/api\/auth/);
  });

  it('drops long-expired pending attempts when a new one starts', async () => {
    await pg.sql`insert into identity.oidc_pending (state, code_verifier, nonce, return_to, expires_at)
      values ('old', 'v', 'n', '/', now() - interval '2 hours')`;
    await app.request('/api/auth/sso/login');
    const states = await pg.sql<{ state: string }[]>`select state from identity.oidc_pending`;
    expect(states.map((s) => s.state)).not.toContain('old');
    expect(states).toHaveLength(1);
  });
});

describe('an identity provider that is down', () => {
  it('start: idp_unavailable while discovery fails; sign-in works once it is back', async () => {
    idp.discoveryDown = true;
    try {
      const fresh = makeApp().app;
      const down = await fresh.request('/api/auth/sso/login?returnTo=/');
      expect(down.status).toBe(302);
      expect(down.headers.get('location')).toBe('/login?loginError=idp_unavailable');
      expect(hasSession(down)).toBe(false);
      idp.discoveryDown = false;
      const up = await fresh.request('/api/auth/sso/login?returnTo=/');
      expect(new URL(up.headers.get('location') ?? '').origin).toBe(idp.issuer);
    } finally {
      idp.discoveryDown = false;
    }
  });

  it('callback: a 5xx from the token endpoint is idp_unavailable, not a rejected login', async () => {
    idp.tokenStatus = 503;
    try {
      const { callback } = await signIn(anna);
      expect(callback.headers.get('location')).toBe('/login?loginError=idp_unavailable');
    } finally {
      idp.tokenStatus = null;
    }
    const failed =
      await pg.sql`select 1 from platform.audit_log where action = 'auth.login_failed'`;
    expect(failed).toHaveLength(0);
  });

  it('an OAuth error answer stays a rejected login, logged with its OAuth code only', async () => {
    idp.tokenStatus = 400;
    let code = '';
    try {
      const attempt = await signIn(anna);
      code = attempt.code;
      expect(attempt.callback.headers.get('location')).toBe('/login?loginError=invalid_state');
    } finally {
      idp.tokenStatus = null;
    }
    const rejected = warnings.filter((w) => w.msg === 'oidc code exchange rejected');
    expect(rejected).toHaveLength(1);
    expect(rejected[0]?.fields).toMatchObject({ code: expect.any(String) });
    expect(JSON.stringify(warnings)).not.toContain(code);
  });

  it('a wrong client secret is logged as invalid_grant', async () => {
    const config = configFor();
    const oidc = config.oidc;
    if (!oidc) throw new Error('no oidc');
    const wrong = makeApp({ oidc: { ...oidc, clientSecret: 'wrong' } }).app;
    const { callback } = await signIn(anna, '/skills', wrong);
    expect(callback.headers.get('location')).toBe('/login?loginError=invalid_state');
    expect(warnings.find((w) => w.msg === 'oidc code exchange rejected')?.fields).toMatchObject({
      oauthError: 'invalid_grant',
    });
    expect(JSON.stringify(warnings)).not.toContain('wrong');
  });
});

describe('hardening', () => {
  it('rate-limits starts per IP with a redirect the login page explains', async () => {
    const starts = await Promise.all(
      Array.from({ length: 31 }, async () => app.request('/api/auth/sso/login')),
    );
    const locations = starts.map((r) => r.headers.get('location') ?? '');
    expect(locations.filter((l) => l.startsWith(idp.issuer))).toHaveLength(30);
    expect(locations.filter((l) => l === '/login?loginError=rate_limited')).toHaveLength(1);
    const [n] = await pg.sql<{ n: number }[]>`select count(*)::int as n from identity.oidc_pending`;
    expect(n?.n).toBe(30);
  });

  it('drops expired pending attempts at once and never stores an over-long returnTo', async () => {
    await pg.sql`insert into identity.oidc_pending (state, code_verifier, nonce, return_to, expires_at)
      values ('just-expired', 'v', 'n', '/', now() - interval '1 second')`;
    await app.request(`/api/auth/sso/login?returnTo=/${'a'.repeat(600)}`);
    const rows = await pg.sql<{ state: string; return_to: string }[]>`
      select state, return_to from identity.oidc_pending`;
    expect(rows.map((r) => r.state)).not.toContain('just-expired');
    expect(rows.map((r) => r.return_to)).toEqual(['/']);
  });

  it('the same sub at another issuer does not land on the old account', async () => {
    await signedIn({ ...anna, groups: ['skills-admins'] });
    // As if OIDC_ISSUER had pointed elsewhere when this account was created.
    await pg.sql`update identity.users set oidc_iss = 'https://old-idp.example'`;
    const cookie = await signedIn(anna);
    expect(
      MeResponse.parse(await (await app.request('/api/auth/me', { headers: { cookie } })).json()),
    ).toEqual({ login: 'anna-2', role: 'member' });
    expect(await userCount()).toBe(2);
  });

  it('not_allowed for a known person ends their sessions; their tokens keep working', async () => {
    const cookie = await signedIn(anna);
    const created = await call('POST', '/api/tokens', cookie, { name: 'laptop' });
    const { token } = CreatedToken.parse(await created.json());
    const { callback } = await signIn({ ...anna, groups: ['family'] });
    expect(callback.headers.get('location')).toBe('/login?loginError=not_allowed');
    expect((await app.request('/api/auth/me', { headers: { cookie } })).status).toBe(401);
    const viaToken = await app.request('/api/auth/me', {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(viaToken.status).toBe(200);
    const [failed] = await pg.sql<{ actor_id: string | null; meta: Record<string, unknown> }[]>`
      select actor_id, meta from platform.audit_log where action = 'auth.login_failed'`;
    expect(failed?.actor_id).not.toBeNull();
    expect(failed?.meta).toMatchObject({ reason: 'not_allowed', sessionsRevoked: true });
  });

  it('refuses a plain-http issuer unless explicitly allowed', async () => {
    const config = configFor();
    const oidc = config.oidc;
    if (!oidc) throw new Error('no oidc');
    const strict = new OpenidProvider({
      issuer: oidc.issuer,
      clientId: oidc.clientId,
      clientSecret: oidc.clientSecret,
      redirectUri: ssoRedirectUri(ORIGIN),
    });
    await expect(
      strict.authorizationUrl({ state: 's', codeChallenge: 'c', nonce: 'n' }),
    ).rejects.toMatchObject({ code: 'idp_unavailable' });
  });
});

describe('password features in single sign-on mode', () => {
  it('password login → 403 sso_only; create user / reset password → 409 sso_managed', async () => {
    await provisionUser(container.identity, { login: 'root', password: PW, role: 'admin' });
    const pw = await app.request('/api/auth/login', {
      method: 'POST',
      headers: { origin: ORIGIN, 'content-type': 'application/json' },
      body: JSON.stringify({ login: 'root', password: PW }),
    });
    expect(pw.status).toBe(403);
    expect(await pw.json()).toMatchObject({ error: { code: 'sso_only' } });

    const admin = await signedIn({ sub: 'sub-root', groups: ['skills-admins'] });
    const create = await call('POST', '/api/users', admin, {
      login: 'bob',
      password: PW,
      role: 'member',
    });
    expect(create.status).toBe(409);
    expect(await create.json()).toMatchObject({ error: { code: 'sso_managed' } });
    const [row] = await pg.sql<
      { id: string }[]
    >`select id from identity.users where login = 'root'`;
    const reset = await call('POST', `/api/users/${row?.id}/password`, admin, { password: PW });
    expect(reset.status).toBe(409);
    expect(await reset.json()).toMatchObject({ error: { code: 'sso_managed' } });
  });

  it('the SSO routes are 404 without OIDC; password login stamps lastLoginAt', async () => {
    const plain = makeApp({}, { sso: false }).app;
    expect((await plain.request('/api/auth/sso/login')).status).toBe(404);
    expect((await plain.request('/api/auth/sso/callback?code=c&state=s')).status).toBe(404);
    await provisionUser(container.identity, { login: 'root', password: PW, role: 'admin' });
    const res = await plain.request('/api/auth/login', {
      method: 'POST',
      headers: { origin: ORIGIN, 'content-type': 'application/json' },
      body: JSON.stringify({ login: 'root', password: PW }),
    });
    expect(res.status).toBe(204);
    const list = await plain.request('/api/users', {
      headers: { cookie: sessionOf(res) },
    });
    const [root] = z.array(UserSummary).parse(await list.json());
    expect(root).toMatchObject({ login: 'root', sso: false, email: null });
    expect(root?.lastLoginAt).not.toBeNull();
  });
});

describe('linking an existing password user (CLI link-sso / unlink-sso)', () => {
  it('SSO lands on the linked user: same id, login and working API token', async () => {
    const created = await provisionUser(container.identity, {
      login: 'bob',
      password: PW,
      role: 'member',
    });
    if (!created.ok) throw created.error;
    const token = await cli(['create-token', 'bob', '--name', 'laptop']);
    expect(token.code).toBe(0);
    const sk = token.out[0] ?? '';

    expect(await cli(['link-sso', 'bob', 'sub-bob'])).toMatchObject({
      code: 0,
      out: ['linked "bob" to sub-bob'],
    });
    expect(await cli(['link-sso', 'bob', 'sub-bob'])).toMatchObject({
      code: 0,
      out: ['already linked'],
    });

    const cookie = await signedIn({
      sub: 'sub-bob',
      preferred_username: 'robert',
      groups: ['skills-admins'],
    });
    expect(
      MeResponse.parse(await (await app.request('/api/auth/me', { headers: { cookie } })).json()),
    ).toEqual({ login: 'bob', role: 'admin' });
    const [row] = await pg.sql<
      { id: string }[]
    >`select id from identity.users where oidc_sub = 'sub-bob'`;
    expect(row?.id).toBe(created.value.id);
    expect(await userCount()).toBe(1);

    // Bearer tokens keep working in both modes.
    const viaToken = await app.request('/api/auth/me', {
      headers: { authorization: `Bearer ${sk}` },
    });
    expect(viaToken.status).toBe(200);

    const audit = await pg.sql<{ action: string }[]>`
      select action from platform.audit_log where action like 'user.%sso' order by id`;
    expect(audit.map((a) => a.action)).toEqual(['user.link_sso']);
  });

  it('refuses a sub linked to another user; unlink-sso removes the link', async () => {
    await provisionUser(container.identity, { login: 'bob', password: PW, role: 'member' });
    await provisionUser(container.identity, { login: 'carol', password: PW, role: 'member' });
    expect((await cli(['link-sso', 'bob', 'sub-x'])).code).toBe(0);
    const conflict = await cli(['link-sso', 'carol', 'sub-x']);
    expect(conflict.code).toBe(1);
    expect(conflict.err.join('\n')).toContain('sso_linked');
    expect((await cli(['link-sso', 'nobody', 'sub-y'])).code).toBe(1);
    expect((await cli(['link-sso', 'bob'])).code).toBe(2);
    expect((await cli(['link-sso', 'bob', ' '])).code).toBe(2);

    expect(await cli(['unlink-sso', 'bob'])).toMatchObject({ code: 0, out: ['unlinked "bob"'] });
    expect(await cli(['unlink-sso', 'bob'])).toMatchObject({ code: 0, out: ['not linked'] });
    expect((await cli(['unlink-sso', 'nobody'])).code).toBe(1);
    const [row] = await pg.sql<{ oidc_sub: string | null }[]>`
      select oidc_sub from identity.users where login = 'bob'`;
    expect(row?.oidc_sub).toBeNull();
    // After unlinking, the same provider account is a new person.
    await signedIn({ sub: 'sub-x', preferred_username: 'bob', groups: ['skills-users'] });
    expect(await userCount()).toBe(3);
  });

  it('prints link-sso and unlink-sso in the usage', async () => {
    const r = await cli([]);
    expect(r.code).toBe(2);
    expect(r.err.join('\n')).toMatch(/link-sso <login> <sub>/);
    expect(r.err.join('\n')).toMatch(/unlink-sso <login>/);
  });
});

describe('the provider with its own scopes and groups claim', () => {
  it('asks for the configured scopes and reads groups from the configured claim', async () => {
    const claim = 'https://example.com/groups';
    idp.expectedScope = 'openid profile email';
    idp.groupsClaim = claim;
    const provider = new OpenidProvider({
      issuer: idp.issuer,
      clientId: idp.clientId,
      clientSecret: idp.clientSecret,
      redirectUri: ssoRedirectUri(ORIGIN),
      scopes: 'openid profile email',
      groupsClaim: claim,
      allowInsecure: true,
    });
    try {
      const verifier = randomBytes(32).toString('base64url');
      const codeChallenge = createHash('sha256').update(verifier).digest('base64url');
      const url = await provider.authorizationUrl({ state: 's', codeChallenge, nonce: 'n' });
      const code = idp.authorize(url, anna);
      const claims = await provider.exchange({
        code,
        codeVerifier: verifier,
        nonce: 'n',
        iss: idp.issuer,
      });
      expect(claims).toEqual({
        sub: 'sub-anna',
        preferredUsername: 'Anna',
        email: 'anna@example.com',
        emailVerified: true,
        groups: ['skills-users'],
      });
    } finally {
      idp.expectedScope = 'openid profile email groups';
      idp.groupsClaim = 'groups';
    }
  });
});

describe('the token CLI and API keep working in SSO mode', () => {
  it('a token created through the API by an SSO user works as Bearer', async () => {
    const cookie = await signedIn(anna);
    const created = await call('POST', '/api/tokens', cookie, { name: 'laptop' });
    expect(created.status).toBe(201);
    const { token } = CreatedToken.parse(await created.json());
    const res = await app.request('/api/skills', { headers: { authorization: `Bearer ${token}` } });
    expect(res.status).toBe(200);
  });
});
