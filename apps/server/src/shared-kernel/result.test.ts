import { describe, expect, it } from 'vite-plus/test';
import { DomainError, err, ok, systemClock } from './index.ts';

describe('shared-kernel', () => {
  it('ok wraps a value', () => {
    expect(ok(1)).toEqual({ ok: true, value: 1 });
  });

  it('err wraps an error', () => {
    expect(err('x')).toEqual({ ok: false, error: 'x' });
  });

  it('DomainError carries a code and message', () => {
    const e = new DomainError('version_conflict', 'm');
    expect(e.code).toBe('version_conflict');
    expect(e.message).toBe('m');
    expect(e).toBeInstanceOf(Error);
  });

  it('systemClock returns the current date', () => {
    const before = Date.now();
    const now = systemClock.now().getTime();
    expect(now).toBeGreaterThanOrEqual(before);
  });
});
