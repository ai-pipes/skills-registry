import type { ConcurrencyGate, RateLimiter } from '../application/ports.ts';

interface Counter {
  count: number;
  windowStart: number;
}

const DEFAULT_MAX_KEYS = 50_000;

/**
 * Fixed-window counter with a lock-out: the (limit+1)-th hit inside a window
 * locks the key for `lockSec`. Every hit counts; callers `reset` on success
 * where appropriate.
 *
 * Counting entries and locks live in separate maps, each with its own cap, so
 * a flood of non-locking keys can only evict other counters, never a lock.
 * Every lock lasts the same `lockSec` and is inserted at the current time, so
 * the locked map's insertion order is also its `lockedUntil` order: the first
 * key is always the one with the earliest expiry, and is the one evicted when
 * the locked map is full. Stale entries are swept at most once per window.
 */
export class InMemoryRateLimiter implements RateLimiter {
  private readonly counters = new Map<string, Counter>();
  private readonly locks = new Map<string, number>();
  private lastSweep: number;
  /** Number of sweeps performed (observability / tests). */
  sweeps = 0;

  constructor(
    private readonly limit: number,
    private readonly windowSec: number,
    private readonly lockSec: number,
    private readonly nowMs: () => number = Date.now,
    private readonly maxKeys: number = DEFAULT_MAX_KEYS,
    private readonly maxLocks: number = DEFAULT_MAX_KEYS,
  ) {
    this.lastSweep = nowMs();
  }

  /** Number of counting entries. */
  get size(): number {
    return this.counters.size;
  }

  /** Number of locked keys. */
  get lockedSize(): number {
    return this.locks.size;
  }

  check(key: string): { allowed: boolean; retryAfterSec: number } {
    const until = this.locks.get(key);
    const now = this.nowMs();
    if (until !== undefined && until > now) {
      return { allowed: false, retryAfterSec: Math.ceil((until - now) / 1000) };
    }
    return { allowed: true, retryAfterSec: 0 };
  }

  hit(key: string): { allowed: boolean; retryAfterSec: number } {
    const now = this.nowMs();
    if (now - this.lastSweep >= this.windowSec * 1000) this.sweep(now);

    const state = this.check(key);
    if (!state.allowed) return state;

    let c = this.counters.get(key);
    if (!c || now - c.windowStart >= this.windowSec * 1000) {
      this.counters.delete(key);
      while (this.counters.size >= this.maxKeys) this.evictFirst(this.counters);
      c = { count: 0, windowStart: now };
      this.counters.set(key, c);
    }
    c.count++;
    if (c.count <= this.limit) return { allowed: true, retryAfterSec: 0 };

    this.counters.delete(key);
    this.locks.delete(key); // re-insert at the end to keep lockedUntil order
    while (this.locks.size >= this.maxLocks) this.evictFirst(this.locks);
    this.locks.set(key, now + this.lockSec * 1000);
    return { allowed: false, retryAfterSec: this.lockSec };
  }

  reset(key: string): void {
    this.counters.delete(key);
    this.locks.delete(key);
  }

  private evictFirst(map: Map<string, unknown>): void {
    const first = map.keys().next();
    if (first.done) return;
    map.delete(first.value);
  }

  private sweep(now: number): void {
    this.lastSweep = now;
    this.sweeps++;
    for (const [k, c] of this.counters) {
      if (now - c.windowStart >= this.windowSec * 1000) this.counters.delete(k);
    }
    for (const [k, until] of this.locks) {
      if (until <= now) this.locks.delete(k);
    }
  }
}

/** Caps simultaneous operations per key. Entries exist only while in flight. */
export class InMemoryConcurrencyGate implements ConcurrencyGate {
  private readonly active = new Map<string, number>();

  constructor(private readonly max: number) {}

  tryEnter(key: string): boolean {
    const n = this.active.get(key) ?? 0;
    if (n >= this.max) return false;
    this.active.set(key, n + 1);
    return true;
  }

  leave(key: string): void {
    const n = (this.active.get(key) ?? 0) - 1;
    if (n <= 0) this.active.delete(key);
    else this.active.set(key, n);
  }
}
