import { describe, expect, it } from 'vite-plus/test';
import { ContentHash } from './content-hash.ts';

describe('ContentHash', () => {
  it('accepts 64 lowercase hex', () => {
    const r = ContentHash.parse('a'.repeat(64));
    expect(r.ok && r.value.value).toBe('a'.repeat(64));
    expect(r.ok && r.value.equals(r.value)).toBe(true);
    expect(r.ok && r.value.toString()).toBe('a'.repeat(64));
  });

  it.each(['', 'a'.repeat(63), 'A'.repeat(64), 'g'.repeat(64)])('rejects %j', (raw) => {
    const r = ContentHash.parse(raw);
    expect(!r.ok && r.error.code).toBe('invalid_path');
  });
});
