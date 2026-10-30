import { err, ok, type Result } from '../../../shared-kernel/index.ts';
import {
  isLoginStateExpired,
  loginBase,
  loginCandidate,
  loginStateExpiry,
  normalizeReturnTo,
} from '../domain/login-flow.ts';
import { accessFor, IdentityError, type OidcClaims, type Role, type User } from '../domain/user.ts';
import type { IdentityDeps } from './ports.ts';
import { startSession } from './sessions.ts';

/** How many `login`, `login-2`, … are tried for a new person before giving up. */
const MAX_LOGIN_ATTEMPTS = 100;

const randomToken = (deps: IdentityDeps): string =>
  Buffer.from(deps.random.bytes(32)).toString('base64url');

const notConfigured = () => new IdentityError('not_found', 'single sign-on is not configured');

const isIdpUnavailable = (error: unknown): error is IdentityError =>
  error instanceof IdentityError && error.code === 'idp_unavailable';

/**
 * Begins Authorization Code + PKCE: returns the provider URL (its `state` binds the attempt) and
 * remembers the attempt. `idp_unavailable` when the provider cannot be reached (nothing is
 * remembered then).
 */
export async function startSsoLogin(
  deps: IdentityDeps,
  input: { returnTo: string },
): Promise<Result<{ url: URL; state: string }, IdentityError>> {
  if (!deps.sso) return err(notConfigured());
  const state = randomToken(deps);
  const nonce = randomToken(deps);
  const codeVerifier = randomToken(deps);
  let url: URL;
  try {
    url = await deps.sso.provider.authorizationUrl({
      state,
      nonce,
      codeChallenge: deps.sha256.base64url(codeVerifier),
    });
  } catch (error) {
    if (isIdpUnavailable(error)) return err(error);
    throw error;
  }
  await deps.pendingLogins.insert({
    state,
    codeVerifier,
    nonce,
    returnTo: normalizeReturnTo(input.returnTo),
    expiresAt: loginStateExpiry(deps.clock.now()),
  });
  return ok({ url, state });
}

/**
 * Finishes single sign-on: checks the state, the provider's answer and the group policy, then
 * creates or refreshes the user (role re-synced from the groups) and starts a web session.
 */
export async function completeSsoLogin(
  deps: IdentityDeps,
  input: { state: string; code: string; iss?: string; ip: string },
): Promise<Result<{ sessionId: string; expiresAt: Date; returnTo: string }, IdentityError>> {
  const sso = deps.sso;
  if (!sso) return err(notConfigured());
  const failed = (reason: string, actorId: string | null = null, extra = {}) =>
    deps.audit.record({
      actorId,
      action: 'auth.login_failed',
      meta: { reason, method: 'sso', ip: input.ip, ...extra },
    });

  const pending = await deps.pendingLogins.consume(input.state);
  if (!pending || isLoginStateExpired(pending.expiresAt, deps.clock.now())) {
    return err(new IdentityError('invalid_state', 'login attempt is unknown or expired'));
  }

  let claims: OidcClaims;
  try {
    claims = await sso.provider.exchange({
      code: input.code,
      codeVerifier: pending.codeVerifier,
      nonce: pending.nonce,
      ...(input.iss === undefined ? {} : { iss: input.iss }),
    });
  } catch (error) {
    if (isIdpUnavailable(error)) return err(error);
    await failed('exchange_failed');
    return err(new IdentityError('invalid_state', 'the identity provider rejected the login'));
  }

  const role = accessFor(claims.groups, sso.policy);
  if (!role) {
    await failed('not_allowed', null, { sub: claims.sub });
    return err(new IdentityError('not_allowed', 'your account is not in an allowed group'));
  }

  const existing = await deps.users.findBySub(claims.sub);
  if (existing?.disabled) {
    await failed('disabled', existing.id);
    return err(new IdentityError('disabled', 'account is disabled'));
  }

  const user = existing
    ? await refreshUser(deps, existing, claims, role)
    : await createSsoUser(deps, claims, role);
  if (user.disabled) {
    // Only reachable when a concurrent first login created the person and they were disabled.
    await failed('disabled', user.id);
    return err(new IdentityError('disabled', 'account is disabled'));
  }
  const session = await startSession(deps, user.id);
  await deps.audit.record({
    actorId: user.id,
    action: 'auth.login',
    meta: { method: 'sso', ip: input.ip },
  });
  return ok({ ...session, returnTo: pending.returnTo });
}

async function refreshUser(
  deps: IdentityDeps,
  user: User,
  claims: OidcClaims,
  role: Role,
): Promise<User> {
  const previousRole = user.role;
  const updated = await deps.users.recordSsoLogin(user.id, {
    email: claims.email,
    groups: claims.groups,
    role,
  });
  if (previousRole !== role) {
    await deps.audit.record({
      actorId: null,
      action: 'user.role_sync',
      target: user.id,
      meta: { from: previousRole, to: role, method: 'sso' },
    });
  }
  return updated;
}

/** A first login: a new user with a unique login (`base`, `base-2`, …) derived from the claims. */
async function createSsoUser(
  deps: IdentityDeps,
  claims: OidcClaims,
  role: Role,
  attempt = 1,
): Promise<User> {
  const base = loginBase(claims);
  if (attempt > MAX_LOGIN_ATTEMPTS) {
    throw new Error(`no free login for "${base}" after ${MAX_LOGIN_ATTEMPTS} attempts`);
  }
  const login = loginCandidate(base, attempt);
  const user = await deps.users.insertSso({
    login,
    oidcSub: claims.sub,
    email: claims.email,
    groups: claims.groups,
    role,
    createdAt: deps.clock.now(),
  });
  if (user) {
    await deps.audit.record({
      actorId: null,
      action: 'user.create',
      target: user.id,
      meta: { login, role, method: 'sso' },
    });
    return user;
  }
  // The same person signing in twice at once: the other request created them.
  const raced = await deps.users.findBySub(claims.sub);
  if (raced) return refreshUser(deps, raced, claims, role);
  return createSsoUser(deps, claims, role, attempt + 1);
}
