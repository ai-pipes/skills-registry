import { err, ok, type Result } from '../../../shared-kernel/index.ts';
import { IdentityError, type Principal } from '../domain/user.ts';
import type { IdentityDeps } from './ports.ts';

const LAST_USED_GRANULARITY_MS = 60_000;
const PREFIX_LENGTH = 10;
const MAX_TOKEN_LENGTH = 100;

export interface TokenSummary {
  id: string;
  name: string;
  prefix: string;
  createdAt: Date;
  lastUsedAt: Date | null;
  revokedAt: Date | null;
}

export async function createToken(
  deps: IdentityDeps,
  input: { principal: Principal; name: string },
): Promise<{ id: string; token: string; prefix: string }> {
  const token = `sk_${Buffer.from(deps.random.bytes(32)).toString('base64url')}`;
  const prefix = token.slice(0, PREFIX_LENGTH);
  const record = await deps.tokens.insert({
    userId: input.principal.userId,
    name: input.name,
    prefix,
    hash: deps.sha256.hex(token),
    createdAt: deps.clock.now(),
  });
  await deps.audit.record({
    actorId: input.principal.userId,
    action: 'token.create',
    target: record.id,
    meta: { name: input.name, prefix, ...(input.principal.via === 'cli' ? { via: 'cli' } : {}) },
  });
  return { id: record.id, token, prefix };
}

export async function listTokens(
  deps: IdentityDeps,
  input: { principal: Principal },
): Promise<TokenSummary[]> {
  const rows = await deps.tokens.listByUser(input.principal.userId);
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    prefix: r.prefix,
    createdAt: r.createdAt,
    lastUsedAt: r.lastUsedAt,
    revokedAt: r.revokedAt,
  }));
}

export async function revokeToken(
  deps: IdentityDeps,
  input: { principal: Principal; id: string },
): Promise<Result<void, IdentityError>> {
  const token = await deps.tokens.findById(input.id);
  if (!token) return err(new IdentityError('not_found', 'token not found'));
  if (token.userId !== input.principal.userId && input.principal.role !== 'admin') {
    return err(new IdentityError('forbidden', 'not your token'));
  }
  if (token.revokedAt) return ok(undefined); // idempotent: nothing changed, nothing to audit
  await deps.tokens.revoke(token.id, deps.clock.now());
  await deps.audit.record({
    actorId: input.principal.userId,
    action: 'token.revoke',
    target: token.id,
  });
  return ok(undefined);
}

/**
 * Failed checks (and only those) are counted per IP. Once an IP exhausts its
 * budget every further failure is `rate_limited`; a request that presents a
 * genuinely valid token is still accepted, since guessing 256 bits is not
 * what the limiter is protecting against.
 */
export async function authenticateToken(
  deps: IdentityDeps,
  input: { token: string; ip: string },
): Promise<Result<Principal, IdentityError>> {
  const reject = (): Result<Principal, IdentityError> => {
    const hit = deps.tokenLimiter.hit(input.ip);
    return hit.allowed
      ? err(new IdentityError('invalid_token', 'invalid token'))
      : err(new IdentityError('rate_limited', 'too many failed attempts', hit.retryAfterSec));
  };

  if (input.token.length > MAX_TOKEN_LENGTH || !input.token.startsWith('sk_')) return reject();
  const hash = deps.sha256.hex(input.token);
  const record = await deps.tokens.findByHash(hash);
  if (!record || !deps.sha256.timingSafeEqual(record.hash, hash) || record.revokedAt) {
    return reject();
  }
  const user = await deps.users.findById(record.userId);
  if (!user || user.disabled) return reject();

  const now = deps.clock.now();
  if (
    !record.lastUsedAt ||
    now.getTime() - record.lastUsedAt.getTime() >= LAST_USED_GRANULARITY_MS
  ) {
    await deps.tokens.touch(record.id, now);
  }
  return ok({ userId: user.id, login: user.login, role: user.role, via: 'token' });
}
