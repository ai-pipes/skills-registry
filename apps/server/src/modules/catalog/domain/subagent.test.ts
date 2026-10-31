import { describe, expect, it } from 'vite-plus/test';
import { ContentHash } from './content-hash.ts';
import { Subagent } from './subagent.ts';
import type { ParsedSubagentMd } from './subagent-md.ts';
import { Slug } from './slug.ts';

const NOW = new Date('2026-01-01T00:00:00Z');
const unwrap = <T>(r: { ok: true; value: T } | { ok: false; error: Error }): T => {
  if (!r.ok) throw r.error;
  return r.value;
};
const slug = (v = 'a') => unwrap(Slug.parse(v));
const hash = (c = 'b') => unwrap(ContentHash.parse(c.repeat(64)));
const md = (over: Partial<ParsedSubagentMd> = {}): ParsedSubagentMd => ({
  name: 'a',
  description: 'd',
  tools: null,
  model: 'inherit',
  skills: [],
  body: '',
  ...over,
});
const make = (over: Partial<ParsedSubagentMd> = {}) =>
  unwrap(
    Subagent.create({
      id: 'id1',
      slug: slug(),
      folderId: 'f1',
      md: md(over),
      contentHash: hash('b'),
      size: 10,
      authorId: 'u1',
      message: null,
      now: NOW,
    }),
  );
const pub = (s: Subagent, baseVersion: number, over: Partial<ParsedSubagentMd> = {}) =>
  s.publish({
    baseVersion,
    md: md(over),
    contentHash: hash('c'),
    size: 11,
    authorId: 'u1',
    message: 'm',
    now: NOW,
  });

describe('Subagent', () => {
  it('create yields version 1 and one event', () => {
    const s = make({ tools: ['Read'], model: 'opus', skills: ['x'] });
    expect(s.currentVersion).toBe(1);
    expect(s.status).toBe('active');
    expect(s.folderId).toBe('f1');
    expect(s.loadedFolderId).toBe('f1');
    expect(s.latest).toMatchObject({
      number: 1,
      name: 'a',
      tools: ['Read'],
      model: 'opus',
      skills: ['x'],
      size: 10,
      restoredFrom: null,
    });
    const ev = s.pullEvents();
    expect(ev).toHaveLength(1);
    expect(ev[0]?.type).toBe('catalog.subagent_version_created');
    expect(ev[0]?.payload).toEqual({ subagentId: 'id1', slug: 'a', version: 1 });
    expect(s.pullEvents()).toEqual([]);
  });

  it('rejects name mismatch on create and publish', () => {
    const r = Subagent.create({
      id: 'x',
      slug: slug('a'),
      folderId: 'f1',
      md: md({ name: 'other' }),
      contentHash: hash(),
      size: 1,
      authorId: 'u',
      message: null,
      now: NOW,
    });
    expect(!r.ok && r.error.code).toBe('name_mismatch');
    const p = pub(make(), 1, { name: 'other' });
    expect(!p.ok && p.error.code).toBe('name_mismatch');
  });

  it('publish increments, stale base conflicts', () => {
    const s = make();
    s.pullEvents();
    const v2 = unwrap(pub(s, 1));
    expect(v2.number).toBe(2);
    expect(s.latest).toBe(v2);
    expect(s.pullEvents()[0]?.payload).toEqual({ subagentId: 'id1', slug: 'a', version: 2 });
    const again = pub(s, 1);
    expect(!again.ok && again.error.code).toBe('version_conflict');
  });

  it('rollback copies the target and records restoredFrom', () => {
    const s = make({ tools: ['Read'], model: 'haiku', skills: ['x'] });
    const v1 = s.latest;
    unwrap(pub(s, 1));
    const v3 = unwrap(s.rollback({ toVersion: v1, baseVersion: 2, authorId: 'u2', now: NOW }));
    expect(v3).toMatchObject({
      number: 3,
      restoredFrom: 1,
      message: 'Rollback to version 1',
      authorId: 'u2',
      tools: ['Read'],
      model: 'haiku',
      skills: ['x'],
      size: 10,
    });
    expect(v3.contentHash).toBe(v1.contentHash);
    const stale = s.rollback({ toVersion: v1, baseVersion: 2, authorId: 'u2', now: NOW });
    expect(!stale.ok && stale.error.code).toBe('version_conflict');
  });

  it('archived subagent rejects writes; archive/restore are idempotent with one event each', () => {
    const s = make();
    s.pullEvents();
    s.archive(NOW);
    s.archive(NOW);
    expect(s.status).toBe('archived');
    expect(s.pullEvents().map((e) => e.type)).toEqual(['catalog.subagent_archived']);
    const p = pub(s, 1);
    expect(!p.ok && p.error.code).toBe('subagent_archived');
    const rb = s.rollback({ toVersion: s.latest, baseVersion: 1, authorId: 'u', now: NOW });
    expect(!rb.ok && rb.error.code).toBe('subagent_archived');
    const w = s.assertWritable(1);
    expect(!w.ok && w.error.code).toBe('subagent_archived');
    s.restore(NOW);
    s.restore(NOW);
    expect(s.status).toBe('active');
    expect(s.pullEvents().map((e) => e.type)).toEqual(['catalog.subagent_restored']);
  });

  it('tracks updatedAt across real changes only', () => {
    const t = (n: number) => new Date(NOW.getTime() + n * 1000);
    const s = make();
    expect(s.updatedAt).toBe(NOW);
    s.archive(t(1));
    s.archive(t(2));
    expect(s.updatedAt).toEqual(t(1));
    s.restore(t(3));
    expect(s.updatedAt).toEqual(t(3));
  });

  it('moveTo another folder emits subagent_moved', () => {
    const later = new Date(NOW.getTime() + 1000);
    const s = make();
    s.pullEvents();
    expect(s.moveTo({ folderId: 'f2', folderSlug: 'devops', now: later })).toEqual({
      ok: true,
      value: true,
    });
    expect(s.folderId).toBe('f2');
    expect(s.loadedFolderId).toBe('f1');
    expect(s.updatedAt).toBe(later);
    expect(s.pullEvents()).toEqual([
      {
        type: 'catalog.subagent_moved',
        occurredAt: later,
        payload: { subagentId: 'id1', slug: 'a', folder: 'devops' },
      },
    ]);
  });

  it('moveTo the same folder is ok(false): no event', () => {
    const s = make();
    s.pullEvents();
    const r = s.moveTo({ folderId: 'f1', folderSlug: 'general', now: new Date(NOW.getTime() + 5) });
    expect(r).toEqual({ ok: true, value: false });
    expect(s.pullEvents()).toEqual([]);
    expect(s.updatedAt).toBe(NOW);
  });

  it('moveTo when archived is an error', () => {
    const s = make();
    s.archive(NOW);
    const r = s.moveTo({ folderId: 'f2', folderSlug: 'x', now: NOW });
    expect(!r.ok && r.error.code).toBe('subagent_archived');
  });

  it('rehydrate has no events', () => {
    const s = make();
    const at = new Date('2026-02-01T00:00:00Z');
    const r = Subagent.rehydrate({
      id: s.id,
      slug: s.slug,
      folderId: 'f9',
      status: 'archived',
      latest: s.latest,
      updatedAt: at,
    });
    expect(r.pullEvents()).toEqual([]);
    expect(r.status).toBe('archived');
    expect(r.folderId).toBe('f9');
    expect(r.loadedFolderId).toBe('f9');
    expect(r.updatedAt).toBe(at);
  });
});
