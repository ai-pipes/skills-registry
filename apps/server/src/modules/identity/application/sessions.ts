import { err, ok, type Result } from '../../../shared-kernel/index.ts';
import { IdentityError, type Principal } from '../domain/user.ts';
import type { IdentityDeps, PasswordHasher } from './ports.ts';

const SESSION_IDLE_MS = 12 * 3600_000;
const SESSION_ABSOLUTE_MS = 30 * 24 * 3600_000;

// Verified against when the login does not exist, so that "no such user" costs
// the same as "wrong password". One lazily computed hash per hasher instance.
const dummyHashes = new WeakMap<PasswordHasher, Promise<string>>();
function dummyHash(deps: IdentityDeps): Promise<string> {
  let h = dummyHashes.get(deps.hasher);
  if (!h) {
    h = deps.hasher.hash(Buffer.from(deps.random.bytes(16)).toString('base64url'));
    dummyHashes.set(deps.hasher, h);
  }
  return h;
}

const MAX_LOGIN_LENGTH = 128;
const MAX_PASSWORD_LENGTH = 1024;

export async function login(
  deps: IdentityDeps,
  input: { login: string; password: string; ip: string },
): Promise<Result<{ sessionId: string; expiresAt: Date }, IdentityError>> {
  // With single sign-on configured the web UI signs in through the provider only.
  if (deps.sso) return err(new IdentityError('sso_only', 'sign in with single sign-on'));
  // The per-IP limiter records failures only (successful logins by many users
  // behind one proxy address must not lock each other out). The check-then-hit
  // gap around the async verify is closed by capping concurrent attempts per
  // IP: at most budget + gate-size attempts can reach verify.
  const ipState = deps.ipLimiter.check(input.ip);
  if (!ipState.allowed) return rateLimited(deps, input.ip, ipState.retryAfterSec);
  if (!deps.ipGate.tryEnter(input.ip)) return rateLimited(deps, input.ip, 1);
  try {
    return await attemptLogin(deps, input);
  } finally {
    deps.ipGate.leave(input.ip);
  }
}

async function rateLimited(
  deps: IdentityDeps,
  ip: string,
  retryAfterSec: number,
): Promise<Result<never, IdentityError>> {
  // Rejections are audited once per IP per lock window, so a flood cannot fill the log.
  if (deps.auditThrottle.shouldRecord(`rate_limited:${ip}`, deps.clock.now())) {
    await deps.audit.record({
      actorId: null,
      action: 'auth.login_failed',
      meta: { ip, reason: 'rate_limited' },
    });
  }
  return err(new IdentityError('rate_limited', 'too many attempts', retryAfterSec));
}

async function attemptLogin(
  deps: IdentityDeps,
  input: { login: string; password: string; ip: string },
): Promise<Result<{ sessionId: string; expiresAt: Date }, IdentityError>> {
  const audit = (reason: string, loginKey?: string) =>
    deps.audit.record({
      actorId: null,
      action: 'auth.login_failed',
      meta: { ...(loginKey === undefined ? {} : { login: loginKey }), ip: input.ip, reason },
    });
  const credentialsFailed = async (loginKey?: string) => {
    const hit = deps.ipLimiter.hit(input.ip);
    await audit('invalid_credentials', loginKey);
    return err(
      hit.allowed
        ? new IdentityError('invalid_credentials', 'invalid login or password')
        : new IdentityError('rate_limited', 'too many attempts', hit.retryAfterSec),
    );
  };

  if (input.login.length > MAX_LOGIN_LENGTH || input.password.length > MAX_PASSWORD_LENGTH) {
    // Oversized input never reaches the DB or the per-login limiter; one dummy
    // verify keeps the timing profile the same as any other failure.
    await deps.hasher.verify(await dummyHash(deps), 'x');
    return credentialsFailed();
  }

  const loginKey = input.login.trim().toLowerCase();
  const byLogin = deps.loginLimiter.hit(loginKey);
  if (!byLogin.allowed) {
    if (deps.auditThrottle.shouldRecord(`locked:${loginKey}`, deps.clock.now())) {
      await audit('locked', loginKey);
    }
    return err(new IdentityError('locked', 'too many failed attempts', byLogin.retryAfterSec));
  }

  const user = await deps.users.findByLogin(loginKey);
  // A user without a password (created by single sign-on) costs the same as an unknown login.
  const hash = user?.passwordHash ?? (await dummyHash(deps));
  const passwordOk = await deps.hasher.verify(hash, input.password);
  if (!user || user.passwordHash === null || !passwordOk) return credentialsFailed(loginKey);
  if (user.disabled) {
    await audit('disabled', loginKey);
    return err(new IdentityError('disabled', 'account is disabled'));
  }

  deps.loginLimiter.reset(loginKey);
  const session = await startSession(deps, user.id);
  await deps.audit.record({ actorId: user.id, action: 'auth.login', meta: { ip: input.ip } });
  return ok(session);
}

/** A new web session for `userId` (password or SSO sign-in); stamps the user's last login. */
export async function startSession(
  deps: IdentityDeps,
  userId: string,
): Promise<{ sessionId: string; expiresAt: Date }> {
  const now = deps.clock.now();
  const sessionId = Buffer.from(deps.random.bytes(32)).toString('base64url');
  const expiresAt = new Date(now.getTime() + SESSION_ABSOLUTE_MS);
  await deps.sessions.insert({
    idHash: deps.sha256.hex(sessionId),
    userId,
    createdAt: now,
    lastSeenAt: now,
    expiresAt,
  });
  await deps.users.setLastLogin(userId, now);
  return { sessionId, expiresAt };
}

export async function logout(deps: IdentityDeps, input: { sessionId: string }): Promise<void> {
  const idHash = deps.sha256.hex(input.sessionId);
  const session = await deps.sessions.findByHash(idHash);
  if (!session) return;
  await deps.sessions.delete(idHash);
  await deps.audit.record({ actorId: session.userId, action: 'auth.logout' });
}

export async function authenticateSession(
  deps: IdentityDeps,
  input: { sessionId: string },
): Promise<Principal | null> {
  const idHash = deps.sha256.hex(input.sessionId);
  const session = await deps.sessions.findByHash(idHash);
  if (!session) return null;
  const now = deps.clock.now();
  const idleDeadline = session.lastSeenAt.getTime() + SESSION_IDLE_MS;
  if (now.getTime() >= session.expiresAt.getTime() || now.getTime() > idleDeadline) {
    await deps.sessions.delete(idHash);
    return null;
  }
  const user = await deps.users.findById(session.userId);
  if (!user || user.disabled) return null;
  await deps.sessions.touch(idHash, now);
  return { userId: user.id, login: user.login, role: user.role, via: 'session' };
}
