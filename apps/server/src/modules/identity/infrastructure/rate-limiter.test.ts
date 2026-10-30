import { describe, expect, it } from 'vite-plus/test';
import { InMemoryConcurrencyGate, InMemoryRateLimiter } from './rate-limiter.ts';

describe('InMemoryRateLimiter', () => {
  it('allows `limit` hits, then locks for lockSec', () => {
    let t = 0;
    const l = new InMemoryRateLimiter(3, 60, 120, () => t);
    for (let i = 0; i < 3; i++) expect(l.hit('k').allowed).toBe(true);
    expect(l.hit('k')).toEqual({ allowed: false, retryAfterSec: 120 });
    t = 60_000; // window passed but still locked
    expect(l.hit('k')).toEqual({ allowed: false, retryAfterSec: 60 });
    t = 120_001;
    expect(l.hit('k').allowed).toBe(true);
  });

  it('keys are independent and reset clears a key', () => {
    const l = new InMemoryRateLimiter(1, 60, 60, () => 0);
    expect(l.hit('a').allowed).toBe(true);
    expect(l.hit('b').allowed).toBe(true);
    expect(l.hit('a').allowed).toBe(false);
    l.reset('a');
    expect(l.hit('a').allowed).toBe(true);
  });

  it('the window slides forward when idle', () => {
    let t = 0;
    const l = new InMemoryRateLimiter(2, 10, 10, () => t);
    l.hit('k');
    l.hit('k');
    t = 10_000;
    expect(l.hit('k').allowed).toBe(true);
  });

  it('check() does not count and reports a lock', () => {
    const l = new InMemoryRateLimiter(1, 60, 60, () => 0);
    for (let i = 0; i < 5; i++) expect(l.check('k').allowed).toBe(true);
    l.hit('k');
    l.hit('k');
    expect(l.check('k')).toEqual({ allowed: false, retryAfterSec: 60 });
  });

  it('is bounded: never holds more than maxKeys, evicting the oldest', () => {
    const l = new InMemoryRateLimiter(1, 60, 60, () => 0, 100);
    for (let i = 0; i < 110; i++) l.hit(`k${i}`);
    expect(l.size).toBeLessThanOrEqual(100);
    expect(l.size).toBe(100);
    // k0 was evicted, so it starts fresh instead of being at its limit
    l.hit('k109');
    expect(l.hit('k109').allowed).toBe(false);
    expect(l.hit('k0').allowed).toBe(true);
  });

  it('sweeps at most once per window, not on every hit', () => {
    let t = 0;
    const l = new InMemoryRateLimiter(1, 10, 1, () => t, 1000);
    for (let i = 0; i < 500; i++) l.hit(`k${i}`);
    expect(l.sweeps).toBe(0);
    t = 10_000;
    for (let i = 0; i < 500; i++) l.hit(`n${i}`);
    expect(l.sweeps).toBe(1);
    expect(l.size).toBe(500); // the stale k* entries were swept, n* are fresh
  });

  it('locks survive any flood of non-locking keys', () => {
    const l = new InMemoryRateLimiter(1, 60, 600, () => 0, 100);
    l.hit('victim');
    l.hit('victim');
    expect(l.check('victim').allowed).toBe(false);
    for (let i = 0; i < 1000; i++) l.hit(`flood${i}`);
    expect(l.size).toBe(100);
    expect(l.check('victim').allowed).toBe(false);
  });

  it('a full locked map evicts the lock with the earliest lockedUntil', () => {
    let t = 0;
    const l = new InMemoryRateLimiter(0, 60, 600, () => t, 100, 3);
    for (const k of ['a', 'b', 'c', 'd']) {
      l.hit(k); // limit 0: every first hit locks
      t += 1000;
    }
    expect(l.lockedSize).toBe(3);
    expect(l.check('a').allowed).toBe(true); // earliest, evicted
    for (const k of ['b', 'c', 'd']) expect(l.check(k).allowed).toBe(false);
  });

  it('expired locks are swept and a re-locked key moves to the end', () => {
    let t = 0;
    const l = new InMemoryRateLimiter(0, 10, 10, () => t, 100, 3);
    l.hit('a');
    t = 11_000; // lock expired; next window sweep removes it
    l.hit('b');
    expect(l.lockedSize).toBe(1);
    l.hit('a'); // re-locks after expiry
    expect(l.check('a').allowed).toBe(false);
  });

  it('reset clears counters and locks', () => {
    const l = new InMemoryRateLimiter(0, 60, 60, () => 0);
    l.hit('k');
    expect(l.check('k').allowed).toBe(false);
    l.reset('k');
    expect(l.check('k').allowed).toBe(true);
  });
});

describe('InMemoryConcurrencyGate', () => {
  it('admits up to max concurrent entries per key and frees them on leave', () => {
    const g = new InMemoryConcurrencyGate(2);
    expect(g.tryEnter('ip')).toBe(true);
    expect(g.tryEnter('ip')).toBe(true);
    expect(g.tryEnter('ip')).toBe(false);
    expect(g.tryEnter('other')).toBe(true);
    g.leave('ip');
    expect(g.tryEnter('ip')).toBe(true);
    g.leave('ip');
    g.leave('ip');
    g.leave('ip'); // extra leave is harmless
    expect(g.tryEnter('ip')).toBe(true);
  });
});
