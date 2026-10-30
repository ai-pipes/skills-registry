import { describe, expect, it } from 'vite-plus/test';
import { groupsOf, isProviderOutage, rejectionCodes } from './openid-provider.ts';

const withCode = (e: Error, code: string) => Object.assign(e, { code });

describe('isProviderOutage', () => {
  it('no answer: a network TypeError, a timeout or an abort', () => {
    expect(isProviderOutage(new TypeError('fetch failed'))).toBe(true);
    expect(isProviderOutage(new DOMException('t', 'TimeoutError'))).toBe(true);
    expect(isProviderOutage(new DOMException('a', 'AbortError'))).toBe(true);
  });

  it('a 5xx answer, on the error or on its cause (the Response)', () => {
    expect(isProviderOutage(Object.assign(new Error('x'), { status: 503 }))).toBe(true);
    expect(isProviderOutage(new Error('x', { cause: { status: 502 } }))).toBe(true);
  });

  it('not an outage: OAuth errors, 4xx, argument errors, non-errors', () => {
    expect(isProviderOutage(Object.assign(new Error('x'), { status: 400 }))).toBe(false);
    expect(isProviderOutage(new Error('x', { cause: { status: 401 } }))).toBe(false);
    expect(isProviderOutage(withCode(new TypeError('bad arg'), 'ERR_INVALID_ARG_TYPE'))).toBe(
      false,
    );
    expect(isProviderOutage(new Error('id token nonce mismatch'))).toBe(false);
    expect(isProviderOutage('boom')).toBe(false);
  });
});

describe('groupsOf', () => {
  it('a list of strings, as most providers emit it', () => {
    expect(groupsOf(['skills-users', 'skills-admins'])).toEqual(['skills-users', 'skills-admins']);
    expect(groupsOf([])).toEqual([]);
  });

  it('the keys of an object, as Zitadel emits project roles', () => {
    expect(groupsOf({ 'skills-users': { '123': 'org.example.com' }, 'skills-admins': {} })).toEqual(
      ['skills-users', 'skills-admins'],
    );
  });

  it('nothing usable: absent, a string, a mixed list, null', () => {
    expect(groupsOf(undefined)).toBeNull();
    expect(groupsOf('skills-users')).toBeNull();
    expect(groupsOf(['skills-users', 1])).toBeNull();
    expect(groupsOf(null)).toBeNull();
  });
});

describe('rejectionCodes', () => {
  it('keeps the OAuth error and the library code', () => {
    const e = Object.assign(new Error('server responded with an error'), {
      error: 'invalid_grant',
      error_description: 'code abc123 was already used',
      code: 'OAUTH_RESPONSE_BODY_ERROR',
    });
    expect(rejectionCodes(e)).toEqual({
      oauthError: 'invalid_grant',
      code: 'OAUTH_RESPONSE_BODY_ERROR',
    });
  });

  it('drops anything that is not a short code', () => {
    expect(rejectionCodes(Object.assign(new Error('x'), { error: 'has spaces in it' }))).toEqual(
      {},
    );
    expect(rejectionCodes(Object.assign(new Error('x'), { code: 'x'.repeat(65) }))).toEqual({});
    expect(rejectionCodes(Object.assign(new Error('x'), { error: 42 }))).toEqual({});
    expect(rejectionCodes(new Error('plain'))).toEqual({});
    expect(rejectionCodes('boom')).toEqual({});
    expect(rejectionCodes(null)).toEqual({});
  });
});
