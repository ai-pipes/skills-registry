import type { OidcClaims } from './user.ts';

const LOGIN_STATE_TTL_MS = 10 * 60_000;

/** When a single sign-on attempt started at `now` stops being valid. */
export function loginStateExpiry(now: Date): Date {
  return new Date(now.getTime() + LOGIN_STATE_TTL_MS);
}

export function isLoginStateExpired(expiresAt: Date, now: Date): boolean {
  return now.getTime() >= expiresAt.getTime();
}

/** Only a same-origin relative path may be a post-login target; anything else becomes `/`. */
export function normalizeReturnTo(raw: string): string {
  if (!raw.startsWith('/') || raw.startsWith('//') || raw.startsWith('/\\')) return '/';
  // CR/LF and other control characters would split headers
  for (const ch of raw) {
    if (ch.charCodeAt(0) < 0x20 || ch === '\u007f') return '/';
  }
  return raw;
}

/** Logins are 1-128 characters (compared case-insensitively). */
export const MAX_LOGIN_LENGTH = 128;

const isSeparator = (ch: string): boolean => {
  const code = ch.charCodeAt(0);
  return code < 0x20 || code === 0x7f || /\s/u.test(ch);
};

/** Lower-cased; runs of whitespace and control characters become one `-`, trimmed at the ends. */
function cleanLogin(raw: string | null): string {
  if (raw === null) return '';
  let out = '';
  for (const ch of raw.toLowerCase()) {
    if (!isSeparator(ch)) out += ch;
    else if (out !== '' && !out.endsWith('-')) out += '-';
  }
  return out.replace(/-+$/, '').slice(0, MAX_LOGIN_LENGTH);
}

const localPart = (email: string | null): string | null => {
  if (email === null) return null;
  const at = email.lastIndexOf('@');
  return at > 0 ? email.slice(0, at) : null;
};

/**
 * The login a person created by single sign-on starts from: `preferred_username`, else the
 * email's local part, else `sub`, reduced to the login rules (lower-case, no whitespace).
 */
export function loginBase(claims: Pick<OidcClaims, 'sub' | 'preferredUsername' | 'email'>): string {
  for (const raw of [claims.preferredUsername, localPart(claims.email), claims.sub]) {
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
