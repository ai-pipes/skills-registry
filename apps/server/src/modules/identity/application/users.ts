import { err, ok, type Result } from '../../../shared-kernel/index.ts';
import { checkPassword, IdentityError, type Principal, type Role } from '../domain/user.ts';
import type { IdentityDeps } from './ports.ts';

export interface UserSummary {
  id: string;
  login: string;
  role: Role;
  disabled: boolean;
  createdAt: Date;
  /** Linked to an identity provider account. */
  sso: boolean;
  email: string | null;
  lastLoginAt: Date | null;
}

const requireAdmin = (p: Principal): IdentityError | null =>
  p.role === 'admin' ? null : new IdentityError('forbidden', 'admin only');

/** With single sign-on configured, people and their passwords live in the identity provider. */
const ssoManaged = (deps: IdentityDeps): IdentityError | null =>
  deps.sso ? new IdentityError('sso_managed', 'users are managed in the identity provider') : null;

async function insertUser(
  deps: IdentityDeps,
  actorId: string | null,
  input: { login: string; password: string; role: Role },
  onlyIfEmpty = false,
): Promise<Result<{ id: string } | null, IdentityError>> {
  const login = input.login.trim();
  if (login === '' || login.length > 128) {
    return err(new IdentityError('invalid_credentials', 'login must be 1-128 characters'));
  }
  const weak = checkPassword(input.password);
  if (weak) return err(weak);
  const row = {
    login,
    passwordHash: await deps.hasher.hash(input.password),
    role: input.role,
    createdAt: deps.clock.now(),
  };
  const user = await (onlyIfEmpty ? deps.users.insertIfEmpty(row) : deps.users.insert(row));
  if (!user) {
    // With onlyIfEmpty a null means "somebody else got there first", not a duplicate login.
    return onlyIfEmpty ? ok(null) : err(new IdentityError('user_exists', 'login already taken'));
  }
  await deps.audit.record({
    actorId,
    action: 'user.create',
    target: user.id,
    meta: { login, role: input.role },
  });
  return ok({ id: user.id });
}

export async function createUser(
  deps: IdentityDeps,
  input: { principal: Principal; login: string; password: string; role: Role },
): Promise<Result<{ id: string }, IdentityError>> {
  const denied = requireAdmin(input.principal) ?? ssoManaged(deps);
  if (denied) return err(denied);
  return insertedUser(await insertUser(deps, input.principal.userId, input));
}

/** `insertUser` only yields null in the onlyIfEmpty mode; the other callers never see it. */
function insertedUser(
  r: Result<{ id: string } | null, IdentityError>,
): Result<{ id: string }, IdentityError> {
  if (!r.ok) return err(r.error);
  return r.value ? ok(r.value) : err(new IdentityError('user_exists', 'login already taken'));
}

export async function listUsers(
  deps: IdentityDeps,
  input: { principal: Principal },
): Promise<Result<UserSummary[], IdentityError>> {
  const denied = requireAdmin(input.principal);
  if (denied) return err(denied);
  const rows = await deps.users.list();
  return ok(
    rows.map((u) => ({
      id: u.id,
      login: u.login,
      role: u.role,
      disabled: u.disabled,
      createdAt: u.createdAt,
      sso: u.oidcSub !== null,
      email: u.email,
      lastLoginAt: u.lastLoginAt,
    })),
  );
}

export async function resetPassword(
  deps: IdentityDeps,
  input: { principal: Principal; userId: string; password: string },
): Promise<Result<void, IdentityError>> {
  const denied = requireAdmin(input.principal) ?? ssoManaged(deps);
  if (denied) return err(denied);
  const weak = checkPassword(input.password);
  if (weak) return err(weak);
  const found = await deps.users.setPasswordHash(
    input.userId,
    await deps.hasher.hash(input.password),
  );
  if (!found) return err(new IdentityError('not_found', 'user not found'));
  await deps.sessions.deleteByUser(input.userId);
  await deps.tokens.revokeAllByUser(input.userId, deps.clock.now());
  await deps.audit.record({
    actorId: input.principal.userId,
    action: 'user.reset_password',
    target: input.userId,
  });
  return ok(undefined);
}

export async function setDisabled(
  deps: IdentityDeps,
  input: { principal: Principal; userId: string; disabled: boolean },
): Promise<Result<void, IdentityError>> {
  const denied = requireAdmin(input.principal);
  if (denied) return err(denied);
  if (input.disabled && input.userId === input.principal.userId) {
    return err(new IdentityError('forbidden', 'cannot disable yourself'));
  }
  const found = await deps.users.setDisabled(input.userId, input.disabled);
  if (!found) return err(new IdentityError('not_found', 'user not found'));
  if (input.disabled) {
    await deps.sessions.deleteByUser(input.userId);
    await deps.tokens.revokeAllByUser(input.userId, deps.clock.now());
  }
  await deps.audit.record({
    actorId: input.principal.userId,
    action: 'user.disable',
    target: input.userId,
    meta: { disabled: input.disabled },
  });
  return ok(undefined);
}

/** Creates the first admin; returns false (and does nothing) if any user exists. */
export async function bootstrapAdmin(
  deps: IdentityDeps,
  input: { login: string; password: string },
): Promise<Result<boolean, IdentityError>> {
  if ((await deps.users.count()) > 0) return ok(false);
  // The count above is only a cheap shortcut; the insert itself is the atomic guard.
  const r = await insertUser(deps, null, { ...input, role: 'admin' }, true);
  return r.ok ? ok(r.value !== null) : err(r.error);
}

/**
 * Operator path (the CLI runs with shell access to the server): creates a user without a
 * principal. Audited with actor `null`, like `bootstrapAdmin`.
 */
export async function provisionUser(
  deps: IdentityDeps,
  input: { login: string; password: string; role: Role },
): Promise<Result<{ id: string }, IdentityError>> {
  return insertedUser(await insertUser(deps, null, input));
}

/** Operator path: acts as an existing, enabled user (e.g. CLI token creation). */
export async function actAs(
  deps: IdentityDeps,
  login: string,
): Promise<Result<Principal, IdentityError>> {
  const user = await deps.users.findByLogin(login.trim());
  if (!user) return err(new IdentityError('not_found', `user "${login}" not found`));
  if (user.disabled) return err(new IdentityError('disabled', `user "${login}" is disabled`));
  return ok({ userId: user.id, login: user.login, role: user.role, via: 'cli' });
}

/**
 * Operator path: links an existing user to the identity provider account `sub`, so their single
 * sign-on lands on this user (keeping id, tokens and authorship). Fails if `sub` belongs to
 * another user; linking the same pair again changes nothing.
 */
export async function linkSso(
  deps: IdentityDeps,
  input: { login: string; sub: string },
): Promise<Result<{ changed: boolean }, IdentityError>> {
  const sub = input.sub.trim();
  if (sub === '') return err(new IdentityError('invalid_input', 'sub must not be empty'));
  const user = await deps.users.findByLogin(input.login.trim());
  if (!user) return err(new IdentityError('not_found', `user "${input.login}" not found`));
  const owner = await deps.users.findBySub(sub);
  if (owner && owner.id !== user.id) {
    return err(new IdentityError('sso_linked', `already linked to user "${owner.login}"`));
  }
  const previousSub = user.oidcSub;
  if (previousSub === sub) return ok({ changed: false });
  await deps.users.setOidcSub(user.id, sub);
  await deps.audit.record({
    actorId: null,
    action: 'user.link_sso',
    target: user.id,
    meta: { login: user.login, sub, previousSub },
  });
  return ok({ changed: true });
}

/** Operator path: removes the link to the identity provider; API tokens keep working. */
export async function unlinkSso(
  deps: IdentityDeps,
  input: { login: string },
): Promise<Result<{ changed: boolean }, IdentityError>> {
  const user = await deps.users.findByLogin(input.login.trim());
  if (!user) return err(new IdentityError('not_found', `user "${input.login}" not found`));
  const sub = user.oidcSub;
  if (sub === null) return ok({ changed: false });
  await deps.users.setOidcSub(user.id, null);
  await deps.audit.record({
    actorId: null,
    action: 'user.unlink_sso',
    target: user.id,
    meta: { login: user.login, sub },
  });
  return ok({ changed: true });
}
