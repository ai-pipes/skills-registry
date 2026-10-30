import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import type {
  IdentityDeps,
  PasswordHasher,
  RateLimiter,
  SessionRecord,
  SessionRepository,
  Sha256,
  TokenRecord,
  TokenRepository,
  UserRepository,
} from '../../src/modules/identity/application/ports.ts';
import { InMemoryAuditThrottle } from '../../src/modules/identity/infrastructure/audit-throttle.ts';
import type { User } from '../../src/modules/identity/domain/user.ts';

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
  async insertIfEmpty(u: Pick<User, 'login' | 'passwordHash' | 'role' | 'createdAt'>) {
    if (this.rows.length > 0) return null;
    // Check and push happen in one synchronous step, like the atomic SQL statement.
    const user: User = { ...u, id: randomUUID(), disabled: false };
    this.rows.push(user);
    return user;
  }
  async list() {
    return [...this.rows];
  }
  async insert(u: Pick<User, 'login' | 'passwordHash' | 'role' | 'createdAt'>) {
    if (await this.findByLogin(u.login)) return null;
    const user: User = { ...u, id: randomUUID(), disabled: false };
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
}

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
  hasher: FakeHasher;
  loginLimiter: FakeLimiter;
  audit: {
    actorId: string | null;
    action: string;
    target?: string;
    meta?: Record<string, unknown>;
  }[];
  time: { now: Date };
}

export function makeEnv(): TestEnv {
  const users = new MemUsers();
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
    hasher,
    sha256: testSha256,
    loginLimiter,
    ipLimiter: new FakeLimiter(20),
    ipGate: new FakeGate(5),
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
  return { deps, users, tokens, sessions, hasher, loginLimiter, audit, time };
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
