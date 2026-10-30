import type { AuditThrottle } from '../application/ports.ts';

const MAX_KEYS = 10_000;

/**
 * Remembers when each key was last recorded; `shouldRecord` is true at most once per `ttlMs`.
 * Bounded: when full, expired entries are dropped first, then the oldest. Map insertion order is
 * recording order because a key is only re-inserted when it is recorded again.
 */
export class InMemoryAuditThrottle implements AuditThrottle {
  private readonly seen = new Map<string, number>();

  constructor(
    private readonly ttlMs: number = 15 * 60_000,
    private readonly maxKeys: number = MAX_KEYS,
  ) {}

  get size(): number {
    return this.seen.size;
  }

  shouldRecord(key: string, now: Date): boolean {
    const t = now.getTime();
    const last = this.seen.get(key);
    if (last !== undefined && t - last < this.ttlMs) return false;
    this.seen.delete(key);
    if (this.seen.size >= this.maxKeys) this.makeRoom(t);
    this.seen.set(key, t);
    return true;
  }

  private makeRoom(now: number): void {
    for (const [k, at] of this.seen) {
      if (now - at >= this.ttlMs) this.seen.delete(k);
      else break; // insertion order is age order: the rest are fresh
    }
    while (this.seen.size >= this.maxKeys) {
      const first = this.seen.keys().next();
      if (first.done) return;
      this.seen.delete(first.value);
    }
  }
}
