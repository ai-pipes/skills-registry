import { describe, expect, it } from 'vite-plus/test';
import { InMemoryAuditThrottle } from './audit-throttle.ts';

const T0 = new Date('2026-01-01T00:00:00Z');
const after = (ms: number) => new Date(T0.getTime() + ms);

describe('InMemoryAuditThrottle', () => {
  it('allows a key once per TTL window', () => {
    const t = new InMemoryAuditThrottle(1000);
    expect(t.shouldRecord('k', T0)).toBe(true);
    expect(t.shouldRecord('k', after(999))).toBe(false);
    expect(t.shouldRecord('k', after(1000))).toBe(true);
    expect(t.shouldRecord('other', after(1000))).toBe(true);
  });

  it('never holds more than 10 000 keys', () => {
    const t = new InMemoryAuditThrottle(60_000);
    for (let i = 0; i < 10_050; i++) t.shouldRecord(`k${i}`, T0);
    expect(t.size).toBe(10_000);
  });
});
