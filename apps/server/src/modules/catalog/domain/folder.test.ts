import { describe, expect, it } from 'vite-plus/test';
import { Folder } from './folder.ts';
import { Slug } from './slug.ts';

const NOW = new Date('2026-01-01T00:00:00Z');
const LATER = new Date('2026-01-02T00:00:00Z');
const slug = (v = 'devops') => {
  const r = Slug.parse(v);
  if (!r.ok) throw r.error;
  return r.value;
};
const make = (over: Partial<{ name: string; description: string }> = {}) => {
  const r = Folder.create({
    id: 'f1',
    slug: slug(),
    name: 'DevOps',
    description: 'Infra skills',
    now: NOW,
    ...over,
  });
  if (!r.ok) throw r.error;
  return r.value;
};

describe('Folder.create', () => {
  it('trims the name and starts active', () => {
    const f = make({ name: '  DevOps  ' });
    expect(f.name).toBe('DevOps');
    expect(f.status).toBe('active');
    expect(f.createdAt).toBe(NOW);
    expect(f.updatedAt).toBe(NOW);
  });

  it.each([
    ['blank name', { name: '   ' }],
    ['101-char name', { name: 'a'.repeat(101) }],
    ['empty description', { description: '' }],
    ['1001-char description', { description: 'a'.repeat(1001) }],
  ])('rejects %s', (_, over) => {
    const r = Folder.create({
      id: 'f',
      slug: slug(),
      name: 'n',
      description: 'd',
      now: NOW,
      ...over,
    });
    expect(!r.ok && r.error.code).toBe('invalid_folder');
  });

  it('accepts boundary lengths', () => {
    const r = Folder.create({
      id: 'f',
      slug: slug(),
      name: 'a'.repeat(100),
      description: 'd'.repeat(1000),
      now: NOW,
    });
    expect(r.ok).toBe(true);
  });

  it('rejects the reserved slug "new"', () => {
    const r = Folder.create({ id: 'f', slug: slug('new'), name: 'n', description: 'd', now: NOW });
    expect(!r.ok && r.error.code).toBe('invalid_slug');
    expect(!r.ok && r.error.message).toContain('/folders/new');
  });
});

describe('Folder.edit', () => {
  it('returns ok(false) and keeps updatedAt when nothing changed', () => {
    const f = make();
    expect(f.edit({ name: 'DevOps', description: 'Infra skills', now: LATER })).toEqual({
      ok: true,
      value: false,
    });
    expect(f.updatedAt).toBe(NOW);
  });

  it('returns ok(true) and bumps updatedAt on change', () => {
    const f = make();
    expect(f.edit({ name: 'Ops', description: 'Infra skills', now: LATER })).toEqual({
      ok: true,
      value: true,
    });
    expect(f.name).toBe('Ops');
    expect(f.updatedAt).toBe(LATER);
  });

  it('rejects an empty name and leaves state intact', () => {
    const f = make();
    const r = f.edit({ name: ' ', description: 'x', now: LATER });
    expect(!r.ok && r.error.code).toBe('invalid_folder');
    expect(f.name).toBe('DevOps');
    expect(f.description).toBe('Infra skills');
    expect(f.updatedAt).toBe(NOW);
  });

  it('is allowed for an archived folder', () => {
    const f = make();
    f.archive(NOW);
    expect(f.edit({ name: 'Ops', description: 'd', now: LATER })).toEqual({
      ok: true,
      value: true,
    });
  });
});

describe('Folder archive/restore', () => {
  it('archive reports a change only once', () => {
    const f = make();
    expect(f.archive(LATER)).toBe(true);
    expect(f.status).toBe('archived');
    expect(f.updatedAt).toBe(LATER);
    expect(f.archive(new Date('2026-02-01T00:00:00Z'))).toBe(false);
    expect(f.updatedAt).toBe(LATER);
  });

  it('restore is symmetric', () => {
    const f = make();
    expect(f.restore(LATER)).toBe(false);
    f.archive(NOW);
    expect(f.restore(LATER)).toBe(true);
    expect(f.status).toBe('active');
    expect(f.restore(LATER)).toBe(false);
  });

  it('rehydrate keeps stored state', () => {
    const f = Folder.rehydrate({
      id: 'f',
      slug: slug(),
      name: 'n',
      description: 'd',
      status: 'archived',
      createdAt: NOW,
      updatedAt: LATER,
    });
    expect(f.status).toBe('archived');
    expect(f.updatedAt).toBe(LATER);
  });
});
