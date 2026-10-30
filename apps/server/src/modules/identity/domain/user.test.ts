import { describe, expect, it } from 'vite-plus/test';
import { checkPassword, IdentityError } from './user.ts';

describe('checkPassword', () => {
  it('rejects short passwords', () => {
    expect(checkPassword('short')?.code).toBe('weak_password');
  });
  it('rejects absurdly long passwords', () => {
    expect(checkPassword('a'.repeat(1025))?.code).toBe('weak_password');
  });
  it('accepts 12 characters', () => {
    expect(checkPassword('a'.repeat(12))).toBeNull();
  });
  it('IdentityError carries its code', () => {
    expect(new IdentityError('locked', 'm', 5)).toMatchObject({ code: 'locked', retryAfterSec: 5 });
  });
});
