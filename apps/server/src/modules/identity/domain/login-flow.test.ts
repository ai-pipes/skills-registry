import { describe, expect, it } from 'vite-plus/test';
import {
  isLoginStateExpired,
  loginBase,
  loginCandidate,
  loginStateExpiry,
  MAX_LOGIN_LENGTH,
  normalizeReturnTo,
} from './login-flow.ts';

describe('normalizeReturnTo', () => {
  it.each([
    ['/skills/code-review', '/skills/code-review'],
    ['/tokens?x=1#h', '/tokens?x=1#h'],
    ['https://evil.example/', '/'],
    ['//evil', '/'],
    ['/\\evil', '/'],
    ['javascript:alert(1)', '/'],
    ['', '/'],
    ['skills', '/'],
    ['/a\r\nb', '/'],
    ['/a\u007fb', '/'],
  ])('%j → %j', (input, expected) => {
    expect(normalizeReturnTo(input)).toBe(expected);
  });
});

describe('login state lifetime', () => {
  const now = new Date('2026-01-01T00:00:00Z');
  it('lives for 10 minutes', () => {
    const exp = loginStateExpiry(now);
    expect(exp.getTime() - now.getTime()).toBe(10 * 60_000);
    expect(isLoginStateExpired(exp, new Date(exp.getTime() - 1))).toBe(false);
    expect(isLoginStateExpired(exp, exp)).toBe(true);
  });
});

const claims = (preferredUsername: string | null, email: string | null, sub = 'sub-1') => ({
  sub,
  preferredUsername,
  email,
});

describe('loginBase', () => {
  it('prefers preferred_username, lower-cased', () => {
    expect(loginBase(claims('Anna.K', 'x@example.com'))).toBe('anna.k');
  });
  it('falls back to the email local part', () => {
    expect(loginBase(claims(null, 'Boris@Example.com'))).toBe('boris');
    expect(loginBase(claims('   ', 'boris@example.com'))).toBe('boris');
  });
  it('falls back to sub when neither is usable', () => {
    expect(loginBase(claims(null, '@example.com', 'ABC-123'))).toBe('abc-123');
    expect(loginBase(claims(null, 'no-at-sign', 'abc'))).toBe('abc');
  });
  it('replaces whitespace and control characters, trims separators', () => {
    expect(loginBase(claims(' Anna  Maria\t\n', null))).toBe('anna-maria');
    expect(loginBase(claims('a\u0000b\u007f', null))).toBe('a-b');
  });
  it('keeps within the length limit', () => {
    expect(loginBase(claims('a'.repeat(300), null))).toHaveLength(MAX_LOGIN_LENGTH);
  });
  it('has a last resort for a blank sub', () => {
    expect(loginBase(claims(null, null, ' '))).toBe('user');
  });
});

describe('loginCandidate', () => {
  it('is the base first, then base-2, base-3…', () => {
    expect(loginCandidate('anna', 1)).toBe('anna');
    expect(loginCandidate('anna', 2)).toBe('anna-2');
    expect(loginCandidate('anna', 13)).toBe('anna-13');
  });
  it('shortens the base so the suffix fits', () => {
    const c = loginCandidate('a'.repeat(MAX_LOGIN_LENGTH), 10);
    expect(c).toHaveLength(MAX_LOGIN_LENGTH);
    expect(c.endsWith('-10')).toBe(true);
  });
});
