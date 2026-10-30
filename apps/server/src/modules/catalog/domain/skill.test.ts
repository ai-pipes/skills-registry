import { describe, expect, it } from 'vite-plus/test';
import { ContentHash } from './content-hash.ts';
import { FilePath } from './file-path.ts';
import { SkillManifest } from './manifest.ts';
import { Skill } from './skill.ts';
import type { ParsedSkillMd } from './skill-md.ts';
import { Slug } from './slug.ts';

const NOW = new Date('2026-01-01T00:00:00Z');
const unwrap = <T>(r: { ok: true; value: T } | { ok: false; error: Error }): T => {
  if (!r.ok) throw r.error;
  return r.value;
};
const slug = (v = 'a') => unwrap(Slug.parse(v));
const md = (name = 'a'): ParsedSkillMd => ({ name, description: 'd', body: '', frontmatter: {} });
const manifest = (hexChar = 'b') =>
  unwrap(
    SkillManifest.create([
      {
        path: unwrap(FilePath.parse('SKILL.md')),
        hash: unwrap(ContentHash.parse(hexChar.repeat(64))),
        size: 1,
        binary: false,
      },
    ]),
  );
const make = () =>
  unwrap(
    Skill.create({
      id: 'id1',
      slug: slug(),
      folderId: 'f1',
      skillMd: md(),
      manifest: manifest('b'),
      authorId: 'u1',
      message: null,
      now: NOW,
      source: null,
      sourceCommit: null,
    }),
  );
const pub = (s: Skill, baseVersion: number, c = 'c') =>
  s.publish({
    baseVersion,
    skillMd: md(),
    manifest: manifest(c),
    authorId: 'u1',
    message: 'm',
    now: NOW,
    sourceCommit: null,
  });

const publishFrom = (s: Skill, sourceCommit: string | null) =>
  s.publish({
    baseVersion: s.currentVersion,
    skillMd: md(),
    manifest: manifest('c'),
    authorId: 'u1',
    message: null,
    now: NOW,
    sourceCommit,
  });

describe('Skill', () => {
  it('create yields version 1 and one event', () => {
    const s = make();
    expect(s.currentVersion).toBe(1);
    expect(s.status).toBe('active');
    const ev = s.pullEvents();
    expect(ev).toHaveLength(1);
    expect(ev[0]?.type).toBe('catalog.skill_version_created');
    expect(ev[0]?.payload).toEqual({ skillId: 'id1', slug: 'a', version: 1 });
    expect(s.pullEvents()).toEqual([]);
  });

  it('rejects name mismatch', () => {
    const r = Skill.create({
      id: 'x',
      slug: slug('a'),
      folderId: 'f1',
      skillMd: md('other'),
      manifest: manifest(),
      authorId: 'u',
      message: null,
      now: NOW,
      source: null,
      sourceCommit: null,
    });
    expect(!r.ok && r.error.code).toBe('name_mismatch');
  });

  it('publish increments, stale base conflicts', () => {
    const s = make();
    s.pullEvents();
    const v2 = unwrap(pub(s, 1));
    expect(v2.number).toBe(2);
    expect(s.currentVersion).toBe(2);
    expect(s.latest).toBe(v2);
    expect(s.pullEvents()[0]?.payload).toEqual({ skillId: 'id1', slug: 'a', version: 2 });
    const again = pub(s, 1);
    expect(!again.ok && again.error.code).toBe('version_conflict');
  });

  it('rollback creates a new version from target', () => {
    const s = make();
    const v1 = s.latest;
    unwrap(pub(s, 1));
    const v3 = unwrap(s.rollback({ toVersion: v1, baseVersion: 2, authorId: 'u2', now: NOW }));
    expect(v3.number).toBe(3);
    expect(v3.restoredFrom).toBe(1);
    expect(v3.manifest).toBe(v1.manifest);
    const stale = s.rollback({ toVersion: v1, baseVersion: 2, authorId: 'u2', now: NOW });
    expect(!stale.ok && stale.error.code).toBe('version_conflict');
  });

  it('archived skill rejects publish and rollback; archive/restore idempotent', () => {
    const s = make();
    s.pullEvents();
    expect(s.archive('u1', NOW).ok).toBe(true);
    expect(s.archive('u1', NOW).ok).toBe(true);
    expect(s.status).toBe('archived');
    expect(s.pullEvents().map((e) => e.type)).toEqual(['catalog.skill_archived']);
    const p = pub(s, 1);
    expect(!p.ok && p.error.code).toBe('skill_archived');
    const rb = s.rollback({ toVersion: s.latest, baseVersion: 1, authorId: 'u', now: NOW });
    expect(!rb.ok && rb.error.code).toBe('skill_archived');
    s.restore('u1', NOW);
    s.restore('u1', NOW);
    expect(s.status).toBe('active');
    expect(s.pullEvents().map((e) => e.type)).toEqual(['catalog.skill_restored']);
  });

  it('rehydrate has no events', () => {
    const s = make();
    const at = new Date('2026-02-01T00:00:00Z');
    const r = Skill.rehydrate({
      id: s.id,
      slug: s.slug,
      folderId: 'f9',
      status: 'archived',
      latest: s.latest,
      updatedAt: at,
      source: null,
    });
    expect(r.pullEvents()).toEqual([]);
    expect(r.status).toBe('archived');
    expect(r.folderId).toBe('f9');
    expect(r.updatedAt).toBe(at);
  });

  it('tracks updatedAt across writes and real status changes only', () => {
    const t = (s: number) => new Date(NOW.getTime() + s * 1000);
    const s = make();
    expect(s.updatedAt).toBe(NOW);
    expect(s.assertWritable(1).ok).toBe(true);
    const stale = s.assertWritable(2);
    expect(!stale.ok && stale.error.code).toBe('version_conflict');
    unwrap(
      s.publish({
        skillMd: md(),
        manifest: manifest('c'),
        authorId: 'u',
        message: null,
        now: t(1),
        baseVersion: 1,
        sourceCommit: null,
      }),
    );
    expect(s.updatedAt).toEqual(t(1));
    unwrap(s.rollback({ toVersion: s.latest, baseVersion: 2, authorId: 'u', now: t(2) }));
    expect(s.updatedAt).toEqual(t(2));
    s.archive('u', t(3));
    s.archive('u', t(4));
    expect(s.updatedAt).toEqual(t(3));
    const archived = s.assertWritable(3);
    expect(!archived.ok && archived.error.code).toBe('skill_archived');
    s.restore('u', t(5));
    s.restore('u', t(6));
    expect(s.updatedAt).toEqual(t(5));
  });

  it('create stores folderId', () => {
    expect(make().folderId).toBe('f1');
  });

  it('moveTo another folder changes folderId, updatedAt and emits skill_moved', () => {
    const later = new Date(NOW.getTime() + 1000);
    const s = make();
    s.pullEvents();
    const r = s.moveTo({ folderId: 'f2', folderSlug: 'devops', now: later });
    expect(r).toEqual({ ok: true, value: true });
    expect(s.folderId).toBe('f2');
    expect(s.updatedAt).toBe(later);
    expect(s.pullEvents()).toEqual([
      {
        type: 'catalog.skill_moved',
        occurredAt: later,
        payload: { skillId: 'id1', slug: 'a', folder: 'devops' },
      },
    ]);
  });

  it('moveTo the same folder is ok(false): no event, updatedAt kept', () => {
    const s = make();
    s.pullEvents();
    const r = s.moveTo({ folderId: 'f1', folderSlug: 'general', now: new Date(NOW.getTime() + 5) });
    expect(r).toEqual({ ok: true, value: false });
    expect(s.pullEvents()).toEqual([]);
    expect(s.updatedAt).toBe(NOW);
  });

  it('moveTo rejects an archived skill', () => {
    const s = make();
    s.archive('u', NOW);
    const r = s.moveTo({ folderId: 'f2', folderSlug: 'devops', now: NOW });
    expect(!r.ok && r.error.code).toBe('skill_archived');
    expect(s.folderId).toBe('f1');
  });

  describe('source', () => {
    const SHA = 'a'.repeat(40);
    const SHA2 = 'b'.repeat(40);
    const ref = {
      host: 'github.com',
      repo: 'anthropics/skills',
      path: 'skills/a',
      ref: null,
    } as const;
    const imported = () =>
      unwrap(
        Skill.create({
          id: 'id1',
          slug: slug(),
          folderId: 'f1',
          skillMd: md(),
          manifest: manifest('b'),
          authorId: 'u1',
          message: null,
          now: NOW,
          source: ref,
          sourceCommit: SHA,
        }),
      );

    it('a skill created without a source has none', () => {
      const s = make();
      expect(s.source).toBeNull();
      expect(s.latest.sourceCommit).toBeNull();
    });

    it('create with a source syncs version 1 from the commit', () => {
      const s = imported();
      expect(s.source).toEqual({ ...ref, syncedVersion: 1 });
      expect(s.latest.sourceCommit).toBe(SHA);
    });

    it('create needs a source and a commit together', () => {
      const base = {
        id: 'x',
        slug: slug(),
        folderId: 'f1',
        skillMd: md(),
        manifest: manifest(),
        authorId: 'u',
        message: null,
        now: NOW,
      };
      const noCommit = Skill.create({ ...base, source: ref, sourceCommit: null });
      expect(!noCommit.ok && noCommit.error.code).toBe('invalid_source');
      const noSource = Skill.create({ ...base, source: null, sourceCommit: SHA });
      expect(!noSource.ok && noSource.error.code).toBe('invalid_source');
    });

    it('publish with a commit moves syncedVersion; without one leaves it', () => {
      const s = imported();
      const v2 = unwrap(publishFrom(s, SHA2));
      expect(v2.sourceCommit).toBe(SHA2);
      expect(s.source?.syncedVersion).toBe(2);
      const v3 = unwrap(publishFrom(s, null));
      expect(v3.sourceCommit).toBeNull();
      expect(s.latest.sourceCommit).toBeNull();
      expect(s.source?.syncedVersion).toBe(2);
    });

    it('publish without a commit keeps syncedVersion 1', () => {
      const s = imported();
      unwrap(publishFrom(s, null));
      expect(s.source?.syncedVersion).toBe(1);
      expect(s.latest.sourceCommit).toBeNull();
    });

    it('publish with a commit on a skill without a source is not_imported', () => {
      const s = make();
      const r = publishFrom(s, SHA);
      expect(!r.ok && r.error.code).toBe('not_imported');
      expect(s.currentVersion).toBe(1);
    });

    it('rollback writes no commit and keeps the source', () => {
      const s = imported();
      const v1 = s.latest;
      unwrap(publishFrom(s, SHA2));
      const v3 = unwrap(s.rollback({ toVersion: v1, baseVersion: 2, authorId: 'u', now: NOW }));
      expect(v3.sourceCommit).toBeNull();
      expect(s.source?.syncedVersion).toBe(2);
    });

    it('rehydrate restores the source', () => {
      const s = imported();
      const r = Skill.rehydrate({
        id: s.id,
        slug: s.slug,
        folderId: 'f1',
        status: 'active',
        latest: s.latest,
        updatedAt: NOW,
        source: { ...ref, syncedVersion: 1 },
      });
      expect(r.source).toEqual({ ...ref, syncedVersion: 1 });
    });
  });
});
