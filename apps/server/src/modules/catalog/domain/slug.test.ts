import { describe, expect, it } from 'vite-plus/test';
import { Slug } from './slug.ts';

describe('Slug', () => {
  it('accepts kebab-case', () => {
    const r = Slug.parse('code-review');
    expect(r.ok && r.value.value).toBe('code-review');
  });

  it.each(['Code_Review', '-a', 'a--b', '', 'a'.repeat(65)])('rejects %j', (raw) => {
    const r = Slug.parse(raw);
    expect(!r.ok && r.error.code).toBe('invalid_slug');
  });

  it('parses "new": a pre-existing skill with that slug can still be loaded', () => {
    const r = Slug.parse('new');
    expect(r.ok && r.value.value).toBe('new');
  });

  it('marks "new" as reserved for new skills: /skills/new is the new-skill page', () => {
    const reserved = Slug.parse('new');
    const free = Slug.parse('new-skill');
    expect(reserved.ok && Slug.isReserved(reserved.value)).toBe(true);
    expect(free.ok && Slug.isReserved(free.value)).toBe(false);
  });

  it('accepts 64 chars and compares by value', () => {
    const a = Slug.parse('a'.repeat(64));
    const b = Slug.parse('a'.repeat(64));
    expect(a.ok && b.ok && a.value.equals(b.value)).toBe(true);
    expect(a.ok && a.value.toString()).toBe('a'.repeat(64));
  });

  it('reservedError names the page by kind, skill by default', () => {
    const r = Slug.parse('new');
    if (!r.ok) throw r.error;
    expect(Slug.reservedError(r.value).message).toBe(
      'slug "new" is reserved: /skills/new is the new-skill page',
    );
    expect(Slug.reservedError(r.value, 'folder').message).toBe(
      'slug "new" is reserved: /folders/new is the new-folder page',
    );
  });
});
