import type { AuditLog, Clock } from '../../../shared-kernel/index.ts';
import type { Role, User } from '../domain/user.ts';

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

/** Dedupes audit records for limiter rejections: true at most once per key per window. */
export interface AuditThrottle {
  shouldRecord(key: string, now: Date): boolean;
}

export interface IdentityDeps {
  users: UserRepository;
  tokens: TokenRepository;
  sessions: SessionRepository;
  hasher: PasswordHasher;
  sha256: Sha256;
  loginLimiter: RateLimiter;
  ipLimiter: RateLimiter;
  ipGate: ConcurrencyGate;
  tokenLimiter: RateLimiter;
  auditThrottle: AuditThrottle;
  audit: AuditLog;
  clock: Clock;
  random: { bytes(n: number): Uint8Array };
}
