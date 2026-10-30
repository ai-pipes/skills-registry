import type { OidcClaims } from './user.ts';

const LOGIN_STATE_TTL_MS = 10 * 60_000;

/** When a single sign-on attempt started at `now` stops being valid. */
export function loginStateExpiry(now: Date): Date {
  return new Date(now.getTime() + LOGIN_STATE_TTL_MS);
}

export function isLoginStateExpired(expiresAt: Date, now: Date): boolean {
  return now.getTime() >= expiresAt.getTime();
}

/** Longer post-login targets are not stored (they would only bloat pending attempts). */
const MAX_RETURN_TO_LENGTH = 512;

/**
 * Only a same-origin relative path of at most `MAX_RETURN_TO_LENGTH` characters may be a
 * post-login target; anything else becomes `/`.
 */
export function normalizeReturnTo(raw: string): string {
  if (raw.length > MAX_RETURN_TO_LENGTH) return '/';
  if (!raw.startsWith('/') || raw.startsWith('//') || raw.startsWith('/\\')) return '/';
  // CR/LF and other control characters would split headers
  for (const ch of raw) {
    if (ch.charCodeAt(0) < 0x20 || ch === '\u007f') return '/';
  }
  return raw;
}

/** Logins are 1-128 characters (compared case-insensitively). */
export const MAX_LOGIN_LENGTH = 128;

/**
 * NFKC-normalised and lower-cased, reduced to `[a-z0-9._-]`: every run of other characters
 * (whitespace, zero-width and format characters, look-alikes outside ASCII) becomes one `-`;
 * separators are trimmed at the ends and the result is capped.
 */
function cleanLogin(raw: string | null): string {
  if (raw === null) return '';
  const mapped = raw
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-');
  return mapped
    .replace(/-{2,}/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '')
    .slice(0, MAX_LOGIN_LENGTH)
    .replace(/[-.]+$/, '');
}

const localPart = (email: string | null): string | null => {
  if (email === null) return null;
  const at = email.lastIndexOf('@');
  return at > 0 ? email.slice(0, at) : null;
};

/**
 * The login a person created by single sign-on starts from: `preferred_username`, else the local
 * part of a *verified* email, else `sub`, reduced to `[a-z0-9._-]`; `user` as the last resort.
 */
export function loginBase(
  claims: Pick<OidcClaims, 'sub' | 'preferredUsername' | 'email' | 'emailVerified'>,
): string {
  const email = claims.emailVerified ? localPart(claims.email) : null;
  for (const raw of [claims.preferredUsername, email, claims.sub]) {
    const login = cleanLogin(raw);
    if (login !== '') return login;
  }
  return 'user';
}

/** Attempt 1 is the base itself; attempt n ≥ 2 appends `-n`, keeping the result within the limit. */
export function loginCandidate(base: string, attempt: number): string {
  if (attempt <= 1) return base;
  const suffix = `-${attempt}`;
  return `${base.slice(0, MAX_LOGIN_LENGTH - suffix.length)}${suffix}`;
}
