import { beforeEach, describe, expect, it } from 'vite-plus/test';
import { type Audited, makeCatalogDeps } from '../../../../test/fakes/catalog-deps.ts';
import type { FixedClock } from '../../../../test/fakes/fixed-clock.ts';
import type { InMemorySkillRepository } from '../../../../test/fakes/in-memory-skill-repository.ts';
import { shaHasher as nodeHasher } from '../../../../test/fakes/sha-hasher.ts';
import { Slug } from '../domain/slug.ts';
import { archiveSkill, restoreSkill } from './commands/archive.ts';
import { createSkill } from './commands/create-skill.ts';
import { publishVersion } from './commands/publish-version.ts';
import { rollbackSkill } from './commands/rollback.ts';
import type { CatalogDeps } from './deps.ts';
import type { SkillRepository } from './ports.ts';
import { buildVersionInput, type FileInput } from './file-input.ts';
import { MAX_FILE_BYTES, MAX_FILES_PER_SKILL, MAX_SKILL_BYTES } from './limits.ts';
import { diffVersions } from './queries/diff.ts';
import { getSkillFile } from './queries/get-file.ts';
import { getSkill } from './queries/get-skill.ts';
import { getHistory } from './queries/history.ts';
import { listSkills } from './queries/list-skills.ts';

const big = (n: number) => new Uint8Array(n).fill(65);
const enc = (s: string) => new TextEncoder().encode(s);
const md = (name: string, body = 'body') =>
  enc(`---\nname: ${name}\ndescription: does things\n---\n${body}\n`);
const files = (name = 'demo', body = 'body', extra: FileInput[] = []): FileInput[] => [
  { path: 'SKILL.md', bytes: md(name, body) },
  ...extra,
];

let repo: InMemorySkillRepository;
let audit: Audited[];
let deps: CatalogDeps;
let clock: FixedClock;

beforeEach(() => {
  ({ deps, skills: repo, audit, clock } = makeCatalogDeps());
});

const wrap = (o: Partial<SkillRepository>): SkillRepository => ({
  findBySlug: (s) => repo.findBySlug(s),
  findById: (i) => repo.findById(i),
  getVersion: (i, n) => repo.getVersion(i, n),
  listVersions: (i) => repo.listVersions(i),
  listSummaries: (f) => repo.listSummaries(f),
  listActiveInFolder: (i) => repo.listActiveInFolder(i),
  save: (k, b) => repo.save(k, b),
  ...o,
});

const create = (slug = 'demo', f = files(slug)) =>
  createSkill(deps, {
    slug,
    folder: 'general',
    files: f,
    actorId: 'u1',
    message: 'init',
    source: null,
    sourceCommit: null,
  });

async function twoVersions() {
  await create('demo', files('demo', 'first', [{ path: 'old.txt', bytes: enc('old') }]));
  await publishVersion(deps, {
    keepFromBase: [],
    sourceCommit: null,
    slug: 'demo',
    baseVersion: 1,
    files: files('demo', 'second'),
    actorId: 'u',
    message: null,
  });
}

// 1 990 rows of 99 chars + newline = 198 999 chars per file (about 199 000).
const lines = (tag: string) =>
  Array.from({ length: 1_990 }, (_, i) => (i === 3 ? tag : `${i}`).padEnd(99, '-')).join('\n');
const publishPair = async (a: FileInput[], b: FileInput[]) => {
  await create('demo', files('demo', 'x', a));
  await publishVersion(deps, {
    keepFromBase: [],
    sourceCommit: null,
    slug: 'demo',
    baseVersion: 1,
    files: files('demo', 'x', b),
    actorId: 'u',
    message: null,
  });
  const r = await diffVersions(deps, { slug: 'demo', from: 1, to: 2 });
  if (!r.ok) throw r.error;
  return Object.fromEntries(r.value.map((d) => [d.path, d]));
};
const huge = (tag: string) => enc(`${tag}${'a'.repeat(300_000)}`);
const editHeavy = (c: string) =>
  enc(Array.from({ length: 12_000 }, (_, i) => `${c}${i}`).join('\n'));
const NAMES = ['f1', 'f2', 'f3', 'f4', 'f5', 'f6'].map((n) => `${n}.txt`);
const budgetFiles = (tag: string) => NAMES.map((path) => ({ path, bytes: enc(lines(tag)) }));

describe('createSkill / getSkill', () => {
  it('creates and returns SKILL.md separately from the other files', async () => {
    const r = await create('demo', files('demo', 'body', [{ path: 'a/b.txt', bytes: enc('hi') }]));
    expect(r).toEqual({ ok: true, value: { slug: 'demo', version: 1 } });
    const view = await getSkill(deps, { slug: 'demo' });
    if (!view.ok) throw view.error;
    expect(view.value.skillMd).toContain('name: demo');
    expect(view.value.files).toEqual([
      { path: 'a/b.txt', size: 2, binary: false, sha256: nodeHasher.sha256(enc('hi')).value },
    ]);
    expect(view.value).toMatchObject({ version: 1, status: 'active', name: 'demo' });
    expect(audit).toEqual([
      {
        actorId: 'u1',
        action: 'skill.create',
        target: 'demo',
        meta: { version: 1, folder: 'general' },
      },
    ]);
  });

  it('rejects an existing slug, bad slug and bad input', async () => {
    await create();
    const dup = await create();
    expect(!dup.ok && dup.error.code).toBe('skill_exists');
    const bad = await create('Bad Slug');
    expect(!bad.ok && bad.error.code).toBe('invalid_slug');
    const mismatch = await create('other', files('demo'));
    expect(!mismatch.ok && mismatch.error.code).toBe('name_mismatch');
    const noMd = await create('x', [{ path: 'a.txt', bytes: enc('a') }]);
    expect(!noMd.ok && noMd.error.code).toBe('missing_skill_md');
    expect(audit).toHaveLength(1);
  });

  it('rejects the reserved slug "new" with a clear message', async () => {
    const r = await create('new');
    expect(!r.ok && r.error.code).toBe('invalid_slug');
    expect(!r.ok && r.error.message).toBe(
      'slug "new" is reserved: /skills/new is the new-skill page',
    );
    expect(audit).toHaveLength(0);
  });

  it('surfaces a repository skill_exists race as a Result', async () => {
    const racing: CatalogDeps = {
      ...deps,
      skills: wrap({
        findBySlug: async () => null,
      }),
    };
    await create();
    const r = await createSkill(racing, {
      slug: 'demo',
      folder: 'general',
      files: files(),
      actorId: 'u',
      message: null,
      source: null,
      sourceCommit: null,
    });
    expect(!r.ok && r.error.code).toBe('skill_exists');
  });

  it('rethrows unexpected repository errors', async () => {
    const broken: CatalogDeps = {
      ...deps,
      skills: wrap({
        save: async () => {
          throw new Error('db down');
        },
      }),
    };
    await expect(
      createSkill(broken, {
        slug: 'demo',
        folder: 'general',
        files: files(),
        actorId: 'u',
        message: null,
        source: null,
        sourceCommit: null,
      }),
    ).rejects.toThrow('db down');
  });

  it('returns not found for unknown skill, version and bad slug', async () => {
    const a = await getSkill(deps, { slug: 'nope' });
    expect(!a.ok && a.error.code).toBe('skill_not_found');
    await create();
    const b = await getSkill(deps, { slug: 'demo', version: 9 });
    expect(!b.ok && b.error.code).toBe('version_not_found');
    const c = await getSkill(deps, { slug: 'BAD' });
    expect(!c.ok && c.error.code).toBe('invalid_slug');
  });

  it('reports missing SKILL.md content as file_not_found', async () => {
    await create();
    const noBlobs: CatalogDeps = { ...deps, blobs: { get: async () => null } };
    const r = await getSkill(noBlobs, { slug: 'demo' });
    expect(!r.ok && r.error.code).toBe('file_not_found');
  });
});

describe('publishVersion', () => {
  it('publishes a new version and audits it', async () => {
    await create();
    const r = await publishVersion(deps, {
      keepFromBase: [],
      sourceCommit: null,
      slug: 'demo',
      baseVersion: 1,
      files: files('demo', 'new body'),
      actorId: 'u2',
      message: 'm',
    });
    expect(r).toEqual({ ok: true, value: { slug: 'demo', version: 2 } });
    expect(audit.at(-1)).toEqual({
      actorId: 'u2',
      action: 'skill.publish',
      target: 'demo',
      meta: { version: 2 },
    });
  });

  it('rejects a stale baseVersion with version_conflict', async () => {
    await create();
    const cmd = {
      slug: 'demo',
      baseVersion: 1,
      files: files('demo', 'v2'),
      keepFromBase: [],
      sourceCommit: null,
      actorId: 'u',
      message: null,
    };
    await publishVersion(deps, cmd);
    const stale = await publishVersion(deps, { ...cmd, files: files('demo', 'v3') });
    expect(!stale.ok && stale.error.code).toBe('version_conflict');
  });

  it('translates a repository-level CAS failure into version_conflict', async () => {
    await create();
    // Two callers load version 1; the second save loses the CAS in the repository.
    const stale = await repo.findBySlug(await slugOf('demo'));
    await publishVersion(deps, {
      keepFromBase: [],
      sourceCommit: null,
      slug: 'demo',
      baseVersion: 1,
      files: files('demo', 'v2'),
      actorId: 'u',
      message: null,
    });
    const losing: CatalogDeps = {
      ...deps,
      skills: wrap({
        findBySlug: async () => stale,
      }),
    };
    const r = await publishVersion(losing, {
      keepFromBase: [],
      sourceCommit: null,
      slug: 'demo',
      baseVersion: 1,
      files: files('demo', 'v3'),
      actorId: 'u',
      message: null,
    });
    expect(!r.ok && r.error.code).toBe('version_conflict');
  });

  it('fails for unknown skill, invalid slug and invalid files', async () => {
    const cmd = {
      slug: 'nope',
      baseVersion: 1,
      files: files('nope'),
      keepFromBase: [],
      sourceCommit: null,
      actorId: 'u',
      message: null,
    };
    const a = await publishVersion(deps, cmd);
    expect(!a.ok && a.error.code).toBe('skill_not_found');
    const b = await publishVersion(deps, { ...cmd, slug: 'BAD' });
    expect(!b.ok && b.error.code).toBe('invalid_slug');
    await create();
    const c = await publishVersion(deps, { ...cmd, slug: 'demo', files: [] });
    expect(!c.ok && c.error.code).toBe('missing_skill_md');
  });

  it('refuses to publish to an archived skill', async () => {
    await create();
    await archiveSkill(deps, { slug: 'demo', actorId: 'u' });
    const r = await publishVersion(deps, {
      keepFromBase: [],
      sourceCommit: null,
      slug: 'demo',
      baseVersion: 1,
      files: files(),
      actorId: 'u',
      message: null,
    });
    expect(!r.ok && r.error.code).toBe('skill_archived');
  });
});

const script = { path: 'scripts/a.py', bytes: enc('print(1)') };
const publishKeeping = (keepFromBase: string[], f = files('demo', 'v2'), baseVersion = 1) =>
  publishVersion(deps, {
    slug: 'demo',
    baseVersion,
    files: f,
    keepFromBase,
    sourceCommit: null,
    actorId: 'u',
    message: null,
  });
const manifestOf = async (n: number) => {
  const skill = await repo.findBySlug(await slugOf('demo'));
  const v = await repo.getVersion(skill!.id, n);
  return Object.fromEntries(v!.manifest.entries.map((e) => [e.path.value, e]));
};

describe('publishVersion keepFromBase', () => {
  it('keeps base files without re-uploading them', async () => {
    await create('demo', files('demo', 'v1', [script, { path: 'drop.txt', bytes: enc('x') }]));
    const writesBefore = repo.blobWrites.length;
    const r = await publishKeeping(['./scripts/a.py']);
    expect(r).toEqual({ ok: true, value: { slug: 'demo', version: 2 } });
    const [v1, v2] = [await manifestOf(1), await manifestOf(2)];
    expect(Object.keys(v2).toSorted()).toEqual(['SKILL.md', 'scripts/a.py']);
    expect(v2['scripts/a.py']).toEqual(v1['scripts/a.py']);
    // only the new SKILL.md is uploaded; the kept script reuses the stored blob
    expect(repo.blobWrites.slice(writesBefore)).toEqual([v2['SKILL.md']!.hash.value]);
    const file = await getSkillFile(deps, { slug: 'demo', path: 'scripts/a.py' });
    expect(file.ok && new TextDecoder().decode(file.value.bytes)).toBe('print(1)');
  });

  it('can keep SKILL.md itself', async () => {
    await create('demo', files('demo', 'v1', [script]));
    const r = await publishKeeping(['SKILL.md'], [{ path: 'b.txt', bytes: enc('b') }]);
    expect(r.ok).toBe(true);
    const view = await getSkill(deps, { slug: 'demo' });
    expect(view.ok && view.value.skillMd).toContain('v1');
    expect(view.ok && view.value.files.map((f) => f.path)).toEqual(['b.txt']);
    const noBlobs = await publishVersion(
      { ...deps, blobs: { get: async () => null } },
      {
        slug: 'demo',
        baseVersion: 2,
        files: [],
        keepFromBase: ['SKILL.md'],
        sourceCommit: null,
        actorId: 'u',
        message: null,
      },
    );
    expect(!noBlobs.ok && noBlobs.error.code).toBe('file_not_found');
  });

  it('rejects a path both uploaded and kept, unknown and invalid kept paths', async () => {
    await create('demo', files('demo', 'v1', [script]));
    const both = await publishKeeping(['scripts/a.py'], files('demo', 'v2', [script]));
    expect(!both.ok && both.error.code).toBe('duplicate_path');
    const missing = await publishKeeping(['scripts/nope.py']);
    expect(!missing.ok && missing.error.code).toBe('file_not_found');
    const invalid = await publishKeeping(['../etc/passwd']);
    expect(!invalid.ok && invalid.error.code).toBe('invalid_path');
    const twice = await publishKeeping(['scripts/a.py', './scripts/a.py']);
    expect(!twice.ok && twice.error.code).toBe('duplicate_path');
  });

  it('checks the base version and archived status before resolving kept paths', async () => {
    await create('demo', files('demo', 'v1', [script]));
    const stale = await publishKeeping(['scripts/nope.py'], files('demo', 'v2'), 7);
    expect(!stale.ok && stale.error.code).toBe('version_conflict');
    await archiveSkill(deps, { slug: 'demo', actorId: 'u' });
    const archived = await publishKeeping(['scripts/a.py']);
    expect(!archived.ok && archived.error.code).toBe('skill_archived');
  });

  it('applies limits to the combined set', async () => {
    const half = Math.floor(MAX_SKILL_BYTES / 2) + 1;
    const parts = (prefix: string, n: number) =>
      Array.from({ length: n }, (_, i) => ({
        path: `${prefix}${i}.txt`,
        bytes: big(Math.ceil(half / n)),
      }));
    await create('demo', files('demo', 'v1', parts('k', 11)));
    const kept = Array.from({ length: 11 }, (_, i) => `k${i}.txt`);
    const tooBig = await publishKeeping(kept, files('demo', 'v2', parts('n', 11)));
    expect(!tooBig.ok && tooBig.error.code).toBe('limit_exceeded');

    const many = Array.from({ length: MAX_FILES_PER_SKILL - 1 }, (_, i) => ({
      path: `m${i}.txt`,
      bytes: enc('m'),
    }));
    expect((await publishKeeping([], files('demo', 'v2', many))).ok).toBe(true);
    // 499 kept + SKILL.md + one new file = 501
    const keepAll = many.map((f) => f.path);
    const tooMany = await publishKeeping(keepAll, files('demo', 'v3', [script]), 2);
    expect(!tooMany.ok && tooMany.error.code).toBe('limit_exceeded');
    expect((await publishKeeping(keepAll, files('demo', 'v3'), 2)).ok).toBe(true);
  });
});

describe('rollbackSkill', () => {
  it('creates a new version with the old content', async () => {
    await twoVersions();
    const r = await rollbackSkill(deps, {
      slug: 'demo',
      toVersion: 1,
      baseVersion: 2,
      actorId: 'u3',
    });
    expect(r).toEqual({ ok: true, value: { slug: 'demo', version: 3 } });
    const view = await getSkill(deps, { slug: 'demo' });
    if (!view.ok) throw view.error;
    expect(view.value.version).toBe(3);
    expect(view.value.skillMd).toContain('first');
    expect(view.value.files.map((f) => f.path)).toEqual(['old.txt']);
    expect(audit.at(-1)).toEqual({
      actorId: 'u3',
      action: 'skill.rollback',
      target: 'demo',
      meta: { version: 3 },
    });
    const history = await getHistory(deps, { slug: 'demo' });
    if (!history.ok) throw history.error;
    expect(history.value[0]).toMatchObject({ number: 3, restoredFrom: 1 });
  });

  it('rejects out-of-range targets with version_not_found', async () => {
    await twoVersions();
    const results = await Promise.all(
      [0, -1, 2, 3, 1.5].map((toVersion) =>
        rollbackSkill(deps, { slug: 'demo', toVersion, baseVersion: 2, actorId: 'u' }),
      ),
    );
    for (const r of results) expect(!r.ok && r.error.code).toBe('version_not_found');
  });

  it('fails on a missing target row, stale base, unknown skill and bad slug', async () => {
    await twoVersions();
    const gap: CatalogDeps = {
      ...deps,
      skills: wrap({
        getVersion: async () => null,
      }),
    };
    const a = await rollbackSkill(gap, {
      slug: 'demo',
      toVersion: 1,
      baseVersion: 2,
      actorId: 'u',
    });
    expect(!a.ok && a.error.code).toBe('version_not_found');
    const b = await rollbackSkill(deps, {
      slug: 'demo',
      toVersion: 1,
      baseVersion: 1,
      actorId: 'u',
    });
    expect(!b.ok && b.error.code).toBe('version_conflict');
    const c = await rollbackSkill(deps, {
      slug: 'nope',
      toVersion: 1,
      baseVersion: 1,
      actorId: 'u',
    });
    expect(!c.ok && c.error.code).toBe('skill_not_found');
    const d = await rollbackSkill(deps, {
      slug: 'BAD',
      toVersion: 1,
      baseVersion: 1,
      actorId: 'u',
    });
    expect(!d.ok && d.error.code).toBe('invalid_slug');
  });
});

describe('archive / restore / list', () => {
  it('archives, keeps data readable and restores', async () => {
    await create();
    await create('other');
    expect(await archiveSkill(deps, { slug: 'demo', actorId: 'a' })).toEqual({
      ok: true,
      value: undefined,
    });
    const view = await getSkill(deps, { slug: 'demo' });
    expect(view.ok && view.value.status).toBe('archived');
    expect((await listSkills(deps, { status: 'active' })).map((s) => s.slug)).toEqual(['other']);
    expect((await listSkills(deps, { status: 'archived' })).map((s) => s.slug)).toEqual(['demo']);
    expect(await listSkills(deps, { status: 'all' })).toHaveLength(2);
    await restoreSkill(deps, { slug: 'demo', actorId: 'a' });
    const again = await getSkill(deps, { slug: 'demo' });
    expect(again.ok && again.value.status).toBe('active');
    expect(audit.map((e) => e.action)).toEqual([
      'skill.create',
      'skill.create',
      'skill.archive',
      'skill.restore',
    ]);
  });

  it('reports updatedAt from the skill row: publish, archive and restore move it', async () => {
    await create();
    const at = async () => (await listSkills(deps, { status: 'all' }))[0]?.updatedAt.toISOString();
    expect(await at()).toBe('2026-01-01T00:00:00.000Z');
    clock.advance(1000);
    await archiveSkill(deps, { slug: 'demo', actorId: 'a' });
    expect(await at()).toBe('2026-01-01T00:00:01.000Z');
    const view = await getSkill(deps, { slug: 'demo' });
    expect(view.ok && view.value.updatedAt.toISOString()).toBe('2026-01-01T00:00:01.000Z');
    clock.advance(1000);
    await archiveSkill(deps, { slug: 'demo', actorId: 'a' });
    expect(await at()).toBe('2026-01-01T00:00:01.000Z');
    await restoreSkill(deps, { slug: 'demo', actorId: 'a' });
    expect(await at()).toBe('2026-01-01T00:00:02.000Z');
    clock.advance(1000);
    await publishVersion(deps, {
      slug: 'demo',
      baseVersion: 1,
      files: files('demo', 'v2'),
      keepFromBase: [],
      sourceCommit: null,
      actorId: 'u',
      message: null,
    });
    expect(await listSkills(deps, { status: 'all' })).toEqual([
      {
        slug: 'demo',
        name: 'demo',
        description: 'does things',
        status: 'active',
        version: 2,
        updatedAt: new Date('2026-01-01T00:00:03.000Z'),
        folder: { slug: 'general', name: 'General' },
      },
    ]);
  });

  it('fails for unknown or invalid slug and surfaces a status CAS failure', async () => {
    const a = await archiveSkill(deps, { slug: 'nope', actorId: 'a' });
    expect(!a.ok && a.error.code).toBe('skill_not_found');
    const b = await restoreSkill(deps, { slug: 'BAD', actorId: 'a' });
    expect(!b.ok && b.error.code).toBe('invalid_slug');
    await create();
    const stale = await repo.findBySlug(await slugOf('demo'));
    await archiveSkill(deps, { slug: 'demo', actorId: 'a' });
    const losing: CatalogDeps = {
      ...deps,
      skills: wrap({
        findBySlug: async () => stale,
      }),
    };
    const c = await archiveSkill(losing, { slug: 'demo', actorId: 'a' });
    expect(!c.ok && c.error.code).toBe('version_conflict');
  });
});

describe('getSkillFile', () => {
  it('returns file bytes, honours version, and reports missing files', async () => {
    await create('demo', files('demo', 'b', [{ path: 'a.txt', bytes: enc('one') }]));
    await publishVersion(deps, {
      keepFromBase: [],
      sourceCommit: null,
      slug: 'demo',
      baseVersion: 1,
      files: files('demo', 'b', [{ path: 'a.txt', bytes: enc('two') }]),
      actorId: 'u',
      message: null,
    });
    const latest = await getSkillFile(deps, { slug: 'demo', path: 'a.txt' });
    const first = await getSkillFile(deps, { slug: 'demo', path: './a.txt', version: 1 });
    expect(latest.ok && new TextDecoder().decode(latest.value.bytes)).toBe('two');
    expect(first.ok && new TextDecoder().decode(first.value.bytes)).toBe('one');
    const missing = await getSkillFile(deps, { slug: 'demo', path: 'zzz' });
    expect(!missing.ok && missing.error.code).toBe('file_not_found');
    const badPath = await getSkillFile(deps, { slug: 'demo', path: '../x' });
    expect(!badPath.ok && badPath.error.code).toBe('invalid_path');
    const noSkill = await getSkillFile(deps, { slug: 'nope', path: 'a' });
    expect(!noSkill.ok && noSkill.error.code).toBe('skill_not_found');
    const badVersion = await getSkillFile(deps, { slug: 'demo', path: 'a.txt', version: 7 });
    expect(!badVersion.ok && badVersion.error.code).toBe('version_not_found');
    const noBlobs = await getSkillFile(
      { ...deps, blobs: { get: async () => null } },
      { slug: 'demo', path: 'a.txt' },
    );
    expect(!noBlobs.ok && noBlobs.error.code).toBe('file_not_found');
  });
});

describe('getHistory', () => {
  it('lists versions newest first; errors for unknown skill', async () => {
    await create();
    await publishVersion(deps, {
      keepFromBase: [],
      sourceCommit: null,
      slug: 'demo',
      baseVersion: 1,
      files: files('demo', 'x'),
      actorId: 'u2',
      message: 'second',
    });
    const h = await getHistory(deps, { slug: 'demo' });
    if (!h.ok) throw h.error;
    expect(h.value.map((v) => [v.number, v.authorId, v.message])).toEqual([
      [2, 'u2', 'second'],
      [1, 'u1', 'init'],
    ]);
    const missing = await getHistory(deps, { slug: 'nope' });
    expect(!missing.ok && missing.error.code).toBe('skill_not_found');
  });
});

describe('diffVersions', () => {
  it('reports added, removed, modified and unchanged files', async () => {
    await create(
      'demo',
      files('demo', 'line one', [
        { path: 'keep.txt', bytes: enc('same') },
        { path: 'gone.txt', bytes: enc('bye') },
        { path: 'img.bin', bytes: new Uint8Array([0, 1, 2]) },
      ]),
    );
    await publishVersion(deps, {
      keepFromBase: [],
      sourceCommit: null,
      slug: 'demo',
      baseVersion: 1,
      // A non-ASCII line: the patch must decode the files as UTF-8.
      files: files('demo', 'line one\nнова строка', [
        { path: 'keep.txt', bytes: enc('same') },
        { path: 'fresh.txt', bytes: enc('hello') },
        { path: 'img.bin', bytes: new Uint8Array([0, 9]) },
      ]),
      actorId: 'u',
      message: null,
    });
    const r = await diffVersions(deps, { slug: 'demo', from: 1, to: 2 });
    if (!r.ok) throw r.error;
    const byPath = Object.fromEntries(r.value.map((d) => [d.path, d]));
    expect(byPath['SKILL.md']?.status).toBe('modified');
    expect(byPath['SKILL.md']?.patch).toContain('+нова строка');
    expect(byPath['keep.txt']).toEqual({ path: 'keep.txt', status: 'unchanged', patch: null });
    expect(byPath['gone.txt']?.status).toBe('removed');
    expect(byPath['gone.txt']?.patch).toContain('-bye');
    expect(byPath['fresh.txt']?.status).toBe('added');
    expect(byPath['fresh.txt']?.patch).toContain('+hello');
    expect(byPath['img.bin']).toEqual({ path: 'img.bin', status: 'modified', patch: null });
  });

  it('fails for unknown versions, skills and missing blobs', async () => {
    await create();
    const a = await diffVersions(deps, { slug: 'demo', from: 1, to: 5 });
    expect(!a.ok && a.error.code).toBe('version_not_found');
    const b = await diffVersions(deps, { slug: 'demo', from: 5, to: 1 });
    expect(!b.ok && b.error.code).toBe('version_not_found');
    const c = await diffVersions(deps, { slug: 'nope', from: 1, to: 1 });
    expect(!c.ok && c.error.code).toBe('skill_not_found');
    await publishVersion(deps, {
      keepFromBase: [],
      sourceCommit: null,
      slug: 'demo',
      baseVersion: 1,
      files: files('demo', 'changed'),
      actorId: 'u',
      message: null,
    });
    await expect(
      diffVersions({ ...deps, blobs: { get: async () => null } }, { slug: 'demo', from: 1, to: 2 }),
    ).rejects.toThrow('missing');
  });
});

describe('diffVersions bounds', () => {
  it('marks a 300 000 char file as tooLarge without a patch', async () => {
    const d = await publishPair(
      [{ path: 'big.txt', bytes: huge('1') }],
      [{ path: 'big.txt', bytes: huge('2') }],
    );
    expect(d['big.txt']).toEqual({
      path: 'big.txt',
      status: 'modified',
      patch: null,
      tooLarge: true,
    });
  });

  it('gives a normal change a patch without tooLarge', async () => {
    const d = await publishPair(
      [{ path: 'a.txt', bytes: enc('one\ntwo\n') }],
      [{ path: 'a.txt', bytes: enc('one\ntwo\nthree\n') }],
    );
    expect(d['a.txt']?.patch).toContain('+three');
    expect(d['a.txt']).not.toHaveProperty('tooLarge');
  });

  it('abandons a diff that exceeds maxEditLength', async () => {
    const d = await publishPair(
      [{ path: 'x.txt', bytes: editHeavy('p') }],
      [{ path: 'x.txt', bytes: editHeavy('q') }],
    );
    expect(d['x.txt']).toMatchObject({ patch: null, tooLarge: true });
  });

  it('stops diffing and reading once the per-request budget is spent', async () => {
    await create('demo', files('demo', 'x', budgetFiles('')));
    await publishVersion(deps, {
      keepFromBase: [],
      sourceCommit: null,
      slug: 'demo',
      baseVersion: 1,
      files: files('demo', 'x', budgetFiles('!')),
      actorId: 'u',
      message: null,
    });
    let gets = 0;
    const spy = { get: (h: Parameters<typeof repo.get>[0]) => (gets++, repo.get(h)) };
    const r = await diffVersions({ ...deps, blobs: spy }, { slug: 'demo', from: 1, to: 2 });
    if (!r.ok) throw r.error;
    const byPath = Object.fromEntries(r.value.map((d) => [d.path, d]));
    // Each pair is ~397 998 chars: after f1 398k, f2 796k, f3 1.19M >= 1M budget, so f4-f6 are skipped.
    // SKILL.md is unchanged (no read); f1-f3 cost 2 gets each; f4-f6 cost none: 6 gets in total.
    expect(NAMES.map((n) => byPath[n]?.tooLarge === true)).toEqual([
      false,
      false,
      false,
      true,
      true,
      true,
    ]);
    expect(NAMES.slice(0, 3).every((n) => byPath[n]?.patch)).toBe(true);
    expect(gets).toBe(6);
  });

  it('never reads files over the size cap', async () => {
    await create('demo', files('demo', 'x', [{ path: 'big.txt', bytes: huge('1') }]));
    await publishVersion(deps, {
      keepFromBase: [],
      sourceCommit: null,
      slug: 'demo',
      baseVersion: 1,
      files: files('demo', 'x', [{ path: 'big.txt', bytes: huge('2') }]),
      actorId: 'u',
      message: null,
    });
    const requested: string[] = [];
    const spy = {
      get: (h: Parameters<typeof repo.get>[0]) => (requested.push(h.value), repo.get(h)),
    };
    const r = await diffVersions({ ...deps, blobs: spy }, { slug: 'demo', from: 1, to: 2 });
    if (!r.ok) throw r.error;
    expect(r.value.find((d) => d.path === 'big.txt')?.tooLarge).toBe(true);
    // Only the identical-hash-or-small SKILL.md pair may be read: SKILL.md is unchanged here.
    expect(requested).toEqual([]);
  });
});

describe('buildVersionInput', () => {
  it('flags NUL bytes and invalid UTF-8 as binary, valid text as text', () => {
    const r = buildVersionInput(
      files('demo', 'b', [
        { path: 'nul.dat', bytes: new Uint8Array([65, 0, 66]) },
        { path: 'bad.dat', bytes: new Uint8Array([0xff, 0xfe, 0x41]) },
        // Multi-byte UTF-8 (Cyrillic) is still text.
        { path: 'ok.txt', bytes: enc('текст') },
      ]),
      nodeHasher,
    );
    if (!r.ok) throw r.error;
    const flags = Object.fromEntries(r.value.manifest.entries.map((e) => [e.path.value, e.binary]));
    expect(flags).toMatchObject({ 'nul.dat': true, 'bad.dat': true, 'ok.txt': false });
  });

  it('keys blobs by sha256 of the bytes and takes sizes from the bytes', () => {
    const r = buildVersionInput(
      files('demo', 'b', [{ path: 'a.txt', bytes: enc('abc') }]),
      nodeHasher,
    );
    if (!r.ok) throw r.error;
    const entry = r.value.manifest.entries.find((e) => e.path.value === 'a.txt');
    expect(entry?.size).toBe(3);
    expect(entry?.hash.value).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
    expect(r.value.blobs.get(entry?.hash.value ?? '')).toEqual(enc('abc'));
  });

  it('enforces size and count limits', () => {
    const tooBig = buildVersionInput(
      files('demo', 'b', [{ path: 'big.txt', bytes: big(MAX_FILE_BYTES + 1) }]),
      nodeHasher,
    );
    expect(!tooBig.ok && tooBig.error.code).toBe('limit_exceeded');
    const atLimit = buildVersionInput(
      files('demo', 'b', [{ path: 'big.txt', bytes: big(MAX_FILE_BYTES) }]),
      nodeHasher,
    );
    expect(atLimit.ok).toBe(true);
    const many = Array.from({ length: MAX_FILES_PER_SKILL }, (_, i) => ({
      path: `f${i}.txt`,
      bytes: enc('x'),
    }));
    expect(buildVersionInput(files('demo', 'b', many), nodeHasher).ok).toBe(false);
    const total = Array.from({ length: MAX_SKILL_BYTES / MAX_FILE_BYTES + 1 }, (_, i) => ({
      path: `t${i}.txt`,
      bytes: big(MAX_FILE_BYTES),
    }));
    const over = buildVersionInput(files('demo', 'b', total), nodeHasher);
    expect(!over.ok && over.error.code).toBe('limit_exceeded');
  });

  it('rejects invalid paths, duplicates and a binary SKILL.md', () => {
    const badPath = buildVersionInput(
      files('demo', 'b', [{ path: '../x', bytes: enc('x') }]),
      nodeHasher,
    );
    expect(!badPath.ok && badPath.error.code).toBe('invalid_path');
    const dup = buildVersionInput(
      files('demo', 'b', [
        { path: 'A.txt', bytes: enc('x') },
        { path: 'a.txt', bytes: enc('y') },
      ]),
      nodeHasher,
    );
    expect(!dup.ok && dup.error.code).toBe('duplicate_path');
    const binMd = buildVersionInput(
      [{ path: 'SKILL.md', bytes: new Uint8Array([0xff]) }],
      nodeHasher,
    );
    expect(!binMd.ok && binMd.error.code).toBe('invalid_frontmatter');
    const noFm = buildVersionInput(
      [{ path: 'SKILL.md', bytes: enc('no frontmatter') }],
      nodeHasher,
    );
    expect(!noFm.ok && noFm.error.code).toBe('invalid_frontmatter');
  });
});

async function slugOf(raw: string): Promise<Slug> {
  const s = Slug.parse(raw);
  if (!s.ok) throw s.error;
  return s.value;
}

const publishDemo = (sourceCommit: string | null, baseVersion = 1) =>
  publishVersion(deps, {
    slug: 'demo',
    baseVersion,
    files: files('demo', `v${baseVersion + 1}`),
    keepFromBase: [],
    actorId: 'u1',
    message: null,
    sourceCommit,
  });

describe('skill source', () => {
  const SHA = 'a'.repeat(40);
  const SHA2 = 'b'.repeat(40);
  const source = { host: 'github.com', repo: 'anthropics/skills', path: 'skills/demo', ref: null };
  const importDemo = () =>
    createSkill(deps, {
      slug: 'demo',
      folder: 'general',
      files: files('demo', 'v1', [{ path: 'ref.md', bytes: enc('ref') }]),
      actorId: 'u1',
      message: null,
      source,
      sourceCommit: SHA,
    });

  it('create with a source: getSkill shows it at syncedVersion 1 with the commit; audit has both', async () => {
    expect((await importDemo()).ok).toBe(true);
    const view = await getSkill(deps, { slug: 'demo' });
    expect(view.ok && view.value.source).toEqual({ ...source, syncedVersion: 1 });
    expect(view.ok && view.value.sourceCommit).toBe(SHA);
    expect(audit.at(-1)).toEqual({
      actorId: 'u1',
      action: 'skill.create',
      target: 'demo',
      meta: { version: 1, folder: 'general', source: 'anthropics/skills/skills/demo', commit: SHA },
    });
  });

  it('publish with a commit moves syncedVersion; without one keeps it and shows no commit', async () => {
    await importDemo();
    expect((await publishDemo(SHA2)).ok).toBe(true);
    expect(audit.at(-1)?.meta).toEqual({ version: 2, sourceCommit: SHA2 });
    let view = await getSkill(deps, { slug: 'demo' });
    expect(view.ok && view.value.source?.syncedVersion).toBe(2);
    expect(view.ok && view.value.sourceCommit).toBe(SHA2);
    expect((await publishDemo(null, 2)).ok).toBe(true);
    expect(audit.at(-1)?.meta).toEqual({ version: 3 });
    view = await getSkill(deps, { slug: 'demo' });
    expect(view.ok && view.value.source?.syncedVersion).toBe(2);
    expect(view.ok && view.value.sourceCommit).toBeNull();
    const history = await getHistory(deps, { slug: 'demo' });
    expect(history.ok && history.value.map((v) => v.sourceCommit)).toEqual([null, SHA2, SHA]);
  });

  it('publish without a commit keeps syncedVersion 1', async () => {
    await importDemo();
    await publishDemo(null);
    const view = await getSkill(deps, { slug: 'demo' });
    expect(view.ok && view.value.source?.syncedVersion).toBe(1);
    expect(view.ok && view.value.sourceCommit).toBeNull();
  });

  it('a skill made in the registry has no source; a commit for it is not_imported', async () => {
    await create();
    const view = await getSkill(deps, { slug: 'demo' });
    expect(view.ok && view.value.source).toBeNull();
    expect(view.ok && view.value.sourceCommit).toBeNull();
    const r = await publishDemo(SHA);
    expect(!r.ok && r.error.code).toBe('not_imported');
  });

  it('getSkill gives the sha256 of SKILL.md and of every file', async () => {
    await importDemo();
    const view = await getSkill(deps, { slug: 'demo' });
    if (!view.ok) throw view.error;
    expect(view.value.skillMdSha256).toBe(nodeHasher.sha256(md('demo', 'v1')).value);
    expect(view.value.files).toEqual([
      { path: 'ref.md', size: 3, binary: false, sha256: nodeHasher.sha256(enc('ref')).value },
    ]);
  });

  it('rejects an invalid source or commit', async () => {
    const bad = await createSkill(deps, {
      slug: 'demo',
      folder: 'general',
      files: files(),
      actorId: 'u1',
      message: null,
      source: { ...source, repo: 'nope' },
      sourceCommit: SHA,
    });
    expect(!bad.ok && bad.error.code).toBe('invalid_source');
    const badCommit = await createSkill(deps, {
      slug: 'demo',
      folder: 'general',
      files: files(),
      actorId: 'u1',
      message: null,
      source,
      sourceCommit: 'XYZ',
    });
    expect(!badCommit.ok && badCommit.error.code).toBe('invalid_source');
    await importDemo();
    const r = await publishDemo('short');
    expect(!r.ok && r.error.code).toBe('invalid_source');
  });
});
