import { describe, expect, it } from 'vite-plus/test';
import { accessFor, checkPassword, IdentityError } from './user.ts';

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

describe('accessFor', () => {
  const policy = { loginGroup: 'skills-users', adminGroup: 'skills-admins' };
  it('admin group → admin, even without the login group', () => {
    expect(accessFor(['skills-admins'], policy)).toBe('admin');
    expect(accessFor(['skills-users', 'skills-admins'], policy)).toBe('admin');
  });
  it('login group → member', () => {
    expect(accessFor(['other', 'skills-users'], policy)).toBe('member');
  });
  it('neither → refused', () => {
    expect(accessFor([], policy)).toBeNull();
    expect(accessFor(['Skills-Users'], policy)).toBeNull();
  });
});
