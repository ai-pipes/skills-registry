import { DomainError } from '../../../shared-kernel/index.ts';

export type Role = 'admin' | 'member';

export interface Principal {
  userId: string;
  login: string;
  role: Role;
  /** `cli`: an operator acting as this user through the server CLI. */
  via: 'session' | 'token' | 'cli';
}

export interface User {
  id: string;
  login: string;
  /** Null for people created by single sign-on: they have never had a password. */
  passwordHash: string | null;
  role: Role;
  disabled: boolean;
  createdAt: Date;
  /** Issuer and `sub` of the provider account this user is linked to; both null = not linked. */
  oidcIss: string | null;
  oidcSub: string | null;
  email: string | null;
  /** Provider groups as of the last single sign-on. */
  groups: string[];
  /** Last successful web sign-in (password or SSO). */
  lastLoginAt: Date | null;
}

/** What the identity provider tells us about a person. */
export interface OidcClaims {
  sub: string;
  preferredUsername: string | null;
  email: string | null;
  /** The provider vouches for `email` (`email_verified: true`). */
  emailVerified: boolean;
  groups: string[];
}

/** Provider groups that open the door (`loginGroup`) and that make a person an admin. */
export interface GroupPolicy {
  loginGroup: string;
  adminGroup: string;
}

/** The role a person with these groups gets, or null when they may not sign in at all. */
export function accessFor(groups: readonly string[], policy: GroupPolicy): Role | null {
  if (groups.includes(policy.adminGroup)) return 'admin';
  if (groups.includes(policy.loginGroup)) return 'member';
  return null;
}

export type IdentityErrorCode =
  | 'invalid_credentials'
  | 'locked'
  | 'disabled'
  | 'invalid_token'
  | 'rate_limited'
  | 'forbidden'
  | 'weak_password'
  | 'user_exists'
  | 'not_found'
  | 'invalid_input'
  /** Single sign-on: the login attempt is unknown, expired, not from this browser or refused. */
  | 'invalid_state'
  /** Single sign-on: the person is in neither the login nor the admin group. */
  | 'not_allowed'
  /** Single sign-on: the identity provider cannot be reached right now. */
  | 'idp_unavailable'
  /** Password sign-in is off: the web UI signs in with SSO only. */
  | 'sso_only'
  /** People and passwords are managed in the identity provider. */
  | 'sso_managed'
  /** The provider account is already linked to another user. */
  | 'sso_linked';

export class IdentityError extends DomainError {
  constructor(
    override readonly code: IdentityErrorCode,
    message: string,
    readonly retryAfterSec?: number,
  ) {
    super(code, message);
    this.name = 'IdentityError';
  }
}

const MIN_PASSWORD_LENGTH = 12;
const MAX_PASSWORD_LENGTH = 1024; // bounds argon2 work on hostile input

export function checkPassword(password: string): IdentityError | null {
  if (password.length < MIN_PASSWORD_LENGTH) {
    return new IdentityError(
      'weak_password',
      `password must be at least ${MIN_PASSWORD_LENGTH} characters`,
    );
  }
  if (password.length > MAX_PASSWORD_LENGTH) {
    return new IdentityError('weak_password', 'password is too long');
  }
  return null;
}
