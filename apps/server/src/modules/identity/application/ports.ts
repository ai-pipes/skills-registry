import type { AuditLog, Clock } from '../../../shared-kernel/index.ts';
import type { GroupPolicy, OidcClaims, Role, User } from '../domain/user.ts';

export interface PasswordHasher {
  hash(password: string): Promise<string>;
  verify(hash: string, password: string): Promise<boolean>;
}

export interface RateLimiter {
  hit(key: string): { allowed: boolean; retryAfterSec: number };
  /** Non-counting: is the key currently locked out? */
  check(key: string): { allowed: boolean; retryAfterSec: number };
  reset(key: string): void;
}

/** Caps simultaneous in-flight operations per key (closes check-then-act races). */
export interface ConcurrencyGate {
  tryEnter(key: string): boolean;
  leave(key: string): void;
}

export interface Sha256 {
  /** Lower-case hex SHA-256 of a UTF-8 string. */
  hex(input: string): string;
  /** Unpadded base64url SHA-256 of a UTF-8 string (PKCE S256 challenge). */
  base64url(input: string): string;
  /** Constant-time comparison of two strings. */
  timingSafeEqual(a: string, b: string): boolean;
}

export interface TokenRecord {
  id: string;
  userId: string;
  name: string;
  prefix: string;
  hash: string;
  createdAt: Date;
  lastUsedAt: Date | null;
  revokedAt: Date | null;
}

export interface SessionRecord {
  idHash: string;
  userId: string;
  createdAt: Date;
  lastSeenAt: Date;
  expiresAt: Date;
}

export interface UserRepository {
  findByLogin(login: string): Promise<User | null>;
  findById(id: string): Promise<User | null>;
  count(): Promise<number>;
  /** Atomic: inserts only if the users table is empty (race-free); null otherwise. */
  insertIfEmpty(user: {
    login: string;
    passwordHash: string;
    role: Role;
    createdAt: Date;
  }): Promise<User | null>;
  list(): Promise<User[]>;
  /** Returns null if the login is already taken. */
  insert(user: {
    login: string;
    passwordHash: string;
    role: Role;
    createdAt: Date;
  }): Promise<User | null>;
  setPasswordHash(id: string, passwordHash: string): Promise<boolean>;
  setDisabled(id: string, disabled: boolean): Promise<boolean>;
  /** id → login for the given ids; unknown and non-UUID ids are absent from the map. */
  loginsByIds(ids: string[]): Promise<Map<string, string>>;
  /** The user linked to this provider account (issuer + `sub`). */
  findBySubject(subject: OidcSubject): Promise<User | null>;
  /**
   * Creates a user from a first single sign-on (no password). Null when the login or the
   * provider account is already taken (a concurrent first login of the same person).
   */
  insertSso(user: {
    login: string;
    subject: OidcSubject;
    email: string | null;
    groups: string[];
    role: Role;
    createdAt: Date;
  }): Promise<User | null>;
  /** After a single sign-on: refreshes email, groups and role; never touches `disabled`. */
  recordSsoLogin(
    id: string,
    input: { email: string | null; groups: string[]; role: Role },
  ): Promise<User>;
  /** After a password sign-in. */
  setLastLogin(id: string, at: Date): Promise<void>;
  /** Links the user to a provider account, or unlinks it (null). False if the user is unknown. */
  setOidcSubject(id: string, subject: OidcSubject | null): Promise<boolean>;
}

export interface TokenRepository {
  insert(token: Omit<TokenRecord, 'id' | 'lastUsedAt' | 'revokedAt'>): Promise<TokenRecord>;
  findByHash(hash: string): Promise<TokenRecord | null>;
  findById(id: string): Promise<TokenRecord | null>;
  listByUser(userId: string): Promise<TokenRecord[]>;
  revoke(id: string, at: Date): Promise<void>;
  revokeAllByUser(userId: string, at: Date): Promise<void>;
  touch(id: string, at: Date): Promise<void>;
}

export interface SessionRepository {
  insert(session: SessionRecord): Promise<void>;
  findByHash(idHash: string): Promise<SessionRecord | null>;
  touch(idHash: string, at: Date): Promise<void>;
  delete(idHash: string): Promise<void>;
  deleteByUser(userId: string): Promise<void>;
}

/**
 * Talks to the identity provider (OIDC): Authorization Code + PKCE. Both methods throw
 * `IdentityError('idp_unavailable')` while the provider cannot be reached; the server itself,
 * password logins and token auth never wait for it.
 */
export interface OidcProvider {
  authorizationUrl(input: { state: string; codeChallenge: string; nonce: string }): Promise<URL>;
  /** Exchanges the code, checks the ID token (signature, nonce, `iss`) and returns the claims. */
  exchange(input: {
    code: string;
    codeVerifier: string;
    nonce: string;
    /** The `iss` parameter of the callback, when the provider sent one (RFC 9207). */
    iss?: string;
  }): Promise<OidcClaims>;
}

/** A provider account: `sub` is unique only within its issuer. */
export interface OidcSubject {
  iss: string;
  sub: string;
}

/** A started, not yet completed single sign-on. One-time: `consume` removes it. */
export interface PendingLogin {
  state: string;
  codeVerifier: string;
  nonce: string;
  returnTo: string;
  expiresAt: Date;
}

export interface PendingLoginRepository {
  /** Also drops expired attempts, so abandoned logins do not pile up. */
  insert(pending: PendingLogin): Promise<void>;
  /** Atomically removes and returns the record; null if unknown or already consumed. */
  consume(state: string): Promise<PendingLogin | null>;
}

/** Single sign-on settings; present only when OIDC is configured (then the web UI is SSO-only). */
interface SsoDeps {
  /** The configured `OIDC_ISSUER`; accounts are keyed by (issuer, `sub`). */
  issuer: string;
  provider: OidcProvider;
  policy: GroupPolicy;
}

/** Dedupes audit records for limiter rejections: true at most once per key per window. */
export interface AuditThrottle {
  shouldRecord(key: string, now: Date): boolean;
}

export interface IdentityDeps {
  users: UserRepository;
  tokens: TokenRepository;
  sessions: SessionRepository;
  pendingLogins: PendingLoginRepository;
  /** Null: password sign-in (no OIDC configured). Set: the web UI signs in with SSO only. */
  sso: SsoDeps | null;
  hasher: PasswordHasher;
  sha256: Sha256;
  loginLimiter: RateLimiter;
  ipLimiter: RateLimiter;
  ipGate: ConcurrencyGate;
  /** Per IP: how many single sign-ons may be started (each stores a pending attempt). */
  ssoStartLimiter: RateLimiter;
  tokenLimiter: RateLimiter;
  auditThrottle: AuditThrottle;
  audit: AuditLog;
  clock: Clock;
  random: { bytes(n: number): Uint8Array };
}
