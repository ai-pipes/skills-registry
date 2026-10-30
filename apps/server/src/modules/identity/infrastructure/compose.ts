import type { Sql } from '../../../platform/db.ts';
import type { IdentityDeps } from '../application/ports.ts';
import { InMemoryAuditThrottle } from './audit-throttle.ts';
import { Argon2Hasher, cryptoRandom, nodeSha256 } from './crypto.ts';
import {
  PgPendingLoginRepository,
  PgSessionRepository,
  PgTokenRepository,
  PgUserRepository,
} from './pg-repositories.ts';
import { InMemoryConcurrencyGate, InMemoryRateLimiter } from './rate-limiter.ts';

/** Everything in IdentityDeps except the cross-cutting `audit` and `clock` and the SSO settings. */
export type PgIdentity = Omit<IdentityDeps, 'audit' | 'clock' | 'sso'>;

export function createPgIdentity(sql: Sql): PgIdentity {
  return {
    users: new PgUserRepository(sql),
    tokens: new PgTokenRepository(sql),
    sessions: new PgSessionRepository(sql),
    pendingLogins: new PgPendingLoginRepository(sql),
    hasher: new Argon2Hasher(),
    sha256: nodeSha256,
    random: cryptoRandom,
    loginLimiter: new InMemoryRateLimiter(5, 15 * 60, 15 * 60),
    ipLimiter: new InMemoryRateLimiter(20, 15 * 60, 15 * 60),
    ipGate: new InMemoryConcurrencyGate(5),
    tokenLimiter: new InMemoryRateLimiter(30, 60, 60),
    auditThrottle: new InMemoryAuditThrottle(15 * 60_000),
  };
}
