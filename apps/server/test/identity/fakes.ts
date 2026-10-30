import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import type {
  IdentityDeps,
  OidcProvider,
  OidcSubject,
  PasswordHasher,
  PendingLogin,
  PendingLoginRepository,
  RateLimiter,
  SessionRecord,
  SessionRepository,
  Sha256,
  TokenRecord,
  TokenRepository,
  UserRepository,
} from '../../src/modules/identity/application/ports.ts';
import { InMemoryAuditThrottle } from '../../src/modules/identity/infrastructure/audit-throttle.ts';
import {
  IdentityError,
  type OidcClaims,
  type Role,
  type User,
} from '../../src/modules/identity/domain/user.ts';

class FakeHasher implements PasswordHasher {
  verifyCalls = 0;
  async hash(p: string): Promise<string> {
    return `fake$${p}`;
  }
  async verify(hash: string, p: string): Promise<boolean> {
    this.verifyCalls++;
    return hash === `fake$${p}`;
  }
}

class FakeLimiter implements RateLimiter {
  private counts = new Map<string, number>();
  constructor(private readonly limit: number) {}
  hit(key: string) {
    const n = (this.counts.get(key) ?? 0) + 1;
    this.counts.set(key, n);
    return { allowed: n <= this.limit, retryAfterSec: 60 };
  }
  check(key: string) {
    return { allowed: (this.counts.get(key) ?? 0) <= this.limit, retryAfterSec: 60 };
  }
  reset(key: string) {
    this.counts.delete(key);
  }
  has(key: string) {
    return this.counts.has(key);
  }
}

class FakeGate {
  private active = new Map<string, number>();
  constructor(private readonly max: number) {}
  tryEnter(key: string) {
    const n = this.active.get(key) ?? 0;
    if (n >= this.max) return false;
    this.active.set(key, n + 1);
    return true;
  }
  leave(key: string) {
    this.active.set(key, Math.max(0, (this.active.get(key) ?? 0) - 1));
  }
}

type NewPasswordUser = Pick<User, 'login' | 'passwordHash' | 'role' | 'createdAt'>;

const ssoDefaults = { oidcIss: null, oidcSub: null, email: null, groups: [], lastLoginAt: null };

class MemUsers implements UserRepository {
  rows: User[] = [];
  async findByLogin(login: string) {
    return this.rows.find((u) => u.login.toLowerCase() === login.toLowerCase()) ?? null;
  }
  async findById(id: string) {
    return this.rows.find((u) => u.id === id) ?? null;
  }
  async count() {
    return this.rows.length;
  }
  async insertIfEmpty(u: NewPasswordUser) {
    if (this.rows.length > 0) return null;
    // Check and push happen in one synchronous step, like the atomic SQL statement.
    const user: User = { ...ssoDefaults, ...u, id: randomUUID(), disabled: false };
    this.rows.push(user);
    return user;
  }
  async list() {
    return [...this.rows];
  }
  async insert(u: NewPasswordUser) {
    if (await this.findByLogin(u.login)) return null;
    const user: User = { ...ssoDefaults, ...u, id: randomUUID(), disabled: false };
    this.rows.push(user);
    return user;
  }
  async setPasswordHash(id: string, passwordHash: string) {
    const u = this.rows.find((x) => x.id === id);
    if (!u) return false;
    u.passwordHash = passwordHash;
    return true;
  }
  lookups: string[][] = [];
  async loginsByIds(ids: string[]) {
    this.lookups.push(ids);
    return new Map(this.rows.filter((u) => ids.includes(u.id)).map((u) => [u.id, u.login]));
  }
  async setDisabled(id: string, disabled: boolean) {
    const u = this.rows.find((x) => x.id === id);
    if (!u) return false;
    u.disabled = disabled;
    return true;
  }
  async findBySubject(s: OidcSubject) {
    return this.rows.find((u) => u.oidcIss === s.iss && u.oidcSub === s.sub) ?? null;
  }
  /** Runs before each insertSso, e.g. to simulate a concurrent first login. */
  beforeInsertSso: (() => void) | null = null;
  async insertSso({
    subject,
    ...u
  }: {
    login: string;
    subject: OidcSubject;
    email: string | null;
    groups: string[];
    role: Role;
    createdAt: Date;
  }) {
    this.beforeInsertSso?.();
    if ((await this.findByLogin(u.login)) || (await this.findBySubject(subject))) return null;
    const user: User = {
      ...u,
      oidcIss: subject.iss,
      oidcSub: subject.sub,
      id: randomUUID(),
      passwordHash: null,
      disabled: false,
      lastLoginAt: null,
    };
    this.rows.push(user);
    return user;
  }
  async recordSsoLogin(id: string, input: { email: string | null; groups: string[]; role: Role }) {
    const u = this.rows.find((x) => x.id === id);
    if (!u) throw new Error('no such user');
    Object.assign(u, input);
    return { ...u };
  }
  async setLastLogin(id: string, at: Date) {
    const u = this.rows.find((x) => x.id === id);
    if (u) u.lastLoginAt = at;
  }
  async setOidcSubject(id: string, s: OidcSubject | null) {
    const u = this.rows.find((x) => x.id === id);
    if (!u) return false;
    u.oidcIss = s?.iss ?? null;
    u.oidcSub = s?.sub ?? null;
    return true;
  }
}

class MemPendingLogins implements PendingLoginRepository {
  rows: PendingLogin[] = [];
  async insert(p: PendingLogin) {
    this.rows.push({ ...p });
  }
  async consume(state: string) {
    const found = this.rows.find((r) => r.state === state) ?? null;
    this.rows = this.rows.filter((r) => r.state !== state);
    return found;
  }
}

/** A scripted identity provider: `claims` is what the next exchange returns, `fail` what it throws. */
class FakeOidc implements OidcProvider {
  claims: OidcClaims = {
    sub: 'sub-1',
    preferredUsername: 'anna',
    email: null,
    emailVerified: false,
    groups: [],
  };
  /** Thrown by `authorizationUrl` when set. */
  startError: unknown = null;
  /** Thrown by `exchange` when set. */
  exchangeError: unknown = null;
  exchanges: { code: string; codeVerifier: string; nonce: string; iss?: string }[] = [];
  lastChallenge = '';
  async authorizationUrl(input: { state: string; codeChallenge: string; nonce: string }) {
    if (this.startError !== null) throw this.startError;
    this.lastChallenge = input.codeChallenge;
    const url = new URL('https://idp.example/authorize');
    url.searchParams.set('state', input.state);
    url.searchParams.set('nonce', input.nonce);
    url.searchParams.set('code_challenge', input.codeChallenge);
    return url;
  }
  async exchange(input: { code: string; codeVerifier: string; nonce: string; iss?: string }) {
    this.exchanges.push(input);
    if (this.exchangeError !== null) throw this.exchangeError;
    return this.claims;
  }
}

export const idpDown = () => new IdentityError('idp_unavailable', 'down');

class MemTokens implements TokenRepository {
  rows: TokenRecord[] = [];
  async insert(t: Omit<TokenRecord, 'id' | 'lastUsedAt' | 'revokedAt'>) {
    const r: TokenRecord = { ...t, id: randomUUID(), lastUsedAt: null, revokedAt: null };
    this.rows.push(r);
    return r;
  }
  async findByHash(hash: string) {
    return this.rows.find((r) => r.hash === hash) ?? null;
  }
  async findById(id: string) {
    return this.rows.find((r) => r.id === id) ?? null;
  }
  async listByUser(userId: string) {
    return this.rows.filter((r) => r.userId === userId);
  }
  async revoke(id: string, at: Date) {
    const r = this.rows.find((x) => x.id === id);
    if (r) r.revokedAt = at;
  }
  async revokeAllByUser(userId: string, at: Date) {
    for (const r of this.rows) if (r.userId === userId && !r.revokedAt) r.revokedAt = at;
  }
  async touch(id: string, at: Date) {
    const r = this.rows.find((x) => x.id === id);
    if (r) r.lastUsedAt = at;
  }
}

class MemSessions implements SessionRepository {
  rows: SessionRecord[] = [];
  async insert(s: SessionRecord) {
    this.rows.push({ ...s });
  }
  async findByHash(idHash: string) {
    return this.rows.find((r) => r.idHash === idHash) ?? null;
  }
  async touch(idHash: string, at: Date) {
    const r = this.rows.find((x) => x.idHash === idHash);
    if (r) r.lastSeenAt = at;
  }
  async delete(idHash: string) {
    this.rows = this.rows.filter((r) => r.idHash !== idHash);
  }
  async deleteByUser(userId: string) {
    this.rows = this.rows.filter((r) => r.userId !== userId);
  }
}

const testSha256: Sha256 = {
  hex: (s) => createHash('sha256').update(s).digest('hex'),
  base64url: (s) => createHash('sha256').update(s).digest('base64url'),
  timingSafeEqual: (a, b) => {
    const x = Buffer.from(a);
    const y = Buffer.from(b);
    return x.length === y.length && timingSafeEqual(x, y);
  },
};

export interface TestEnv {
  deps: IdentityDeps;
  users: MemUsers;
  tokens: MemTokens;
  sessions: MemSessions;
  pendingLogins: MemPendingLogins;
  oidc: FakeOidc;
  hasher: FakeHasher;
  loginLimiter: FakeLimiter;
  ssoStartLimiter: FakeLimiter;
  audit: {
    actorId: string | null;
    action: string;
    target?: string;
    meta?: Record<string, unknown>;
  }[];
  time: { now: Date };
}

const TEST_POLICY = { loginGroup: 'skills-users', adminGroup: 'skills-admins' };
export const TEST_ISSUER = 'https://idp.example';

/** In-memory identity; with `sso` the single sign-on mode is on (FakeOidc, TEST_POLICY). */
export function makeEnv(opts: { sso?: boolean } = {}): TestEnv {
  const users = new MemUsers();
  const pendingLogins = new MemPendingLogins();
  const oidc = new FakeOidc();
  const ssoStartLimiter = new FakeLimiter(30);
  const tokens = new MemTokens();
  const sessions = new MemSessions();
  const hasher = new FakeHasher();
  const loginLimiter = new FakeLimiter(5);
  const audit: TestEnv['audit'] = [];
  const time = { now: new Date('2026-01-01T00:00:00Z') };
  const deps: IdentityDeps = {
    users,
    tokens,
    sessions,
    pendingLogins,
    sso: opts.sso ? { issuer: TEST_ISSUER, provider: oidc, policy: TEST_POLICY } : null,
    hasher,
    sha256: testSha256,
    loginLimiter,
    ipLimiter: new FakeLimiter(20),
    ipGate: new FakeGate(5),
    ssoStartLimiter,
    tokenLimiter: new FakeLimiter(30),
    audit: {
      record: async (e) => {
        audit.push(e);
      },
    },
    clock: { now: () => new Date(time.now) },
    auditThrottle: new InMemoryAuditThrottle(),
    random: { bytes: (n) => new Uint8Array(randomBytes(n)) },
  };
  return {
    deps,
    users,
    tokens,
    sessions,
    pendingLogins,
    oidc,
    hasher,
    loginLimiter,
    ssoStartLimiter,
    audit,
    time,
  };
}

export async function seedUser(
  env: TestEnv,
  login: string,
  role: 'admin' | 'member' = 'member',
  password = 'correct-horse-battery',
): Promise<User> {
  const u = await env.users.insert({
    login,
    passwordHash: await env.hasher.hash(password),
    role,
    createdAt: env.time.now,
  });
  if (!u) throw new Error('seed failed');
  return u;
}

/** Runs `fn` n times strictly one after another (order matters for rate limiters). */
export function repeat<T>(n: number, fn: (i: number) => Promise<T>): Promise<T[]> {
  return Array.from({ length: n }).reduce<Promise<T[]>>(
    async (acc, _, i) => [...(await acc), await fn(i)],
    Promise.resolve([]),
  );
}
