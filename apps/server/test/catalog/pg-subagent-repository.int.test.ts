import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vite-plus/test';
import { Folder } from '../../src/modules/catalog/domain/folder.ts';
import { FilePath } from '../../src/modules/catalog/domain/file-path.ts';
import { SkillManifest } from '../../src/modules/catalog/domain/manifest.ts';
import { Skill } from '../../src/modules/catalog/domain/skill.ts';
import { Slug } from '../../src/modules/catalog/domain/slug.ts';
import type { ParsedSubagentMd } from '../../src/modules/catalog/domain/subagent-md.ts';
import { Subagent } from '../../src/modules/catalog/domain/subagent.ts';
import { nodeHasher } from '../../src/modules/catalog/infrastructure/node-hasher.ts';
import { PgBlobStore } from '../../src/modules/catalog/infrastructure/pg-blob-store.ts';
import { PgFolderRepository } from '../../src/modules/catalog/infrastructure/pg-folder-repository.ts';
import { PgSkillRepository } from '../../src/modules/catalog/infrastructure/pg-skill-repository.ts';
import { PgSubagentRepository } from '../../src/modules/catalog/infrastructure/pg-subagent-repository.ts';
import { GENERAL_FOLDER_ID, startPg, truncateAll } from '../pg.ts';

let pg: Awaited<ReturnType<typeof startPg>>;
let repo: PgSubagentRepository;
let folders: PgFolderRepository;
let skills: PgSkillRepository;
beforeAll(async () => {
  pg = await startPg();
  repo = new PgSubagentRepository(pg.sql);
  folders = new PgFolderRepository(pg.sql);
  skills = new PgSkillRepository(pg.sql);
});
afterAll(async () => {
  await pg.stop();
});
beforeEach(async () => {
  await truncateAll(pg.sql);
});

const NOW = new Date('2026-01-01T00:00:00Z');
const AUTHOR = randomUUID();
const unwrap = <T>(r: { ok: true; value: T } | { ok: false; error: Error }): T => {
  if (!r.ok) throw r.error;
  return r.value;
};
const slug = (s: string) => unwrap(Slug.parse(s));

function md(name: string, over: Partial<ParsedSubagentMd> = {}): ParsedSubagentMd {
  return { name, description: 'd', tools: null, model: 'inherit', skills: [], body: '', ...over };
}

function content(text: string) {
  const bytes = new TextEncoder().encode(text);
  const hash = nodeHasher.sha256(bytes);
  return { hash, size: bytes.byteLength, blobs: new Map([[hash.value, bytes]]) };
}

function newSubagent(
  s: string,
  over: Partial<ParsedSubagentMd> = {},
  folderId: string = GENERAL_FOLDER_ID,
) {
  const c = content(`---\nname: ${s}\n---\n${randomUUID()}`);
  const subagent = unwrap(
    Subagent.create({
      id: randomUUID(),
      slug: slug(s),
      folderId,
      md: md(s, over),
      contentHash: c.hash,
      size: c.size,
      authorId: AUTHOR,
      message: 'first',
      now: NOW,
    }),
  );
  return { subagent, blobs: c.blobs };
}

async function saved(s: string, over: Partial<ParsedSubagentMd> = {}, folderId?: string) {
  const { subagent, blobs } = newSubagent(s, over, folderId);
  await repo.save(subagent, blobs);
  return subagent;
}

function publish(subagent: Subagent, base: number, over: Partial<ParsedSubagentMd> = {}) {
  const c = content(`v${base + 1} ${randomUUID()}`);
  unwrap(
    subagent.publish({
      baseVersion: base,
      md: md(subagent.slug.value, over),
      contentHash: c.hash,
      size: c.size,
      authorId: AUTHOR,
      message: 'next',
      now: NOW,
    }),
  );
  return c.blobs;
}

async function devops() {
  const folder = unwrap(
    Folder.create({
      id: randomUUID(),
      slug: slug('devops'),
      name: 'DevOps',
      description: 'ops',
      now: NOW,
    }),
  );
  await folders.save(folder);
  return folder;
}

describe('PgSubagentRepository', () => {
  it('round-trips a subagent: frontmatter, blob, tools null vs list, empty skills', async () => {
    const { subagent, blobs } = newSubagent('reviewer', {
      tools: ['Read', 'mcp__skills__get_skill'],
      model: 'opus',
      skills: ['release-runbook', 'code-style'],
    });
    await repo.save(subagent, blobs);
    const inherits = await saved('helper');

    const loaded = (await repo.findBySlug(slug('reviewer')))!;
    expect(loaded.id).toBe(subagent.id);
    expect(loaded.status).toBe('active');
    expect(loaded.folderId).toBe(GENERAL_FOLDER_ID);
    expect(loaded.updatedAt).toEqual(NOW);
    expect(loaded.latest).toEqual(subagent.latest);
    expect(loaded.latest.tools).toEqual(['Read', 'mcp__skills__get_skill']);
    expect(loaded.latest.skills).toEqual(['release-runbook', 'code-style']);

    const other = (await repo.findById(inherits.id))!;
    expect(other.latest.tools).toBeNull();
    expect(other.latest.skills).toEqual([]);
    expect(other.latest.model).toBe('inherit');

    const bytes = await new PgBlobStore(pg.sql).get(loaded.latest.contentHash);
    expect(bytes).toEqual(blobs.get(loaded.latest.contentHash.value));
    expect(await repo.findById(randomUUID())).toBeNull();
    expect(await repo.findBySlug(slug('nope'))).toBeNull();
  });

  it('lists versions, scopes getVersion and writes the outbox', async () => {
    const subagent = await saved('reviewer');
    const loaded = (await repo.findById(subagent.id))!;
    await repo.save(loaded, publish(loaded, 1, { model: 'haiku' }));

    expect((await repo.listVersions(subagent.id)).map((v) => [v.number, v.model])).toEqual([
      [1, 'inherit'],
      [2, 'haiku'],
    ]);
    expect((await repo.getVersion(subagent.id, 2))?.message).toBe('next');
    expect(await repo.getVersion(subagent.id, 3)).toBeNull();
    expect(await repo.getVersion(randomUUID(), 1)).toBeNull();
    const rows = await pg.sql`select type, payload from platform.outbox order by id`;
    expect(rows.map((r) => [r.type, r.payload])).toEqual([
      [
        'catalog.subagent_version_created',
        { subagentId: subagent.id, slug: 'reviewer', version: 1 },
      ],
      [
        'catalog.subagent_version_created',
        { subagentId: subagent.id, slug: 'reviewer', version: 2 },
      ],
    ]);
  });

  it('rejects a taken slug with subagent_exists and writes nothing', async () => {
    await saved('reviewer');
    const dup = newSubagent('reviewer');
    await expect(repo.save(dup.subagent, dup.blobs)).rejects.toMatchObject({
      code: 'subagent_exists',
    });
    expect(await pg.sql`select 1 from catalog.subagents`).toHaveLength(1);
    expect(await pg.sql`select 1 from platform.outbox`).toHaveLength(1);
    expect(await pg.sql`select 1 from catalog.blobs`).toHaveLength(1);
  });

  it('rejects concurrent publishes on the same base', async () => {
    const subagent = await saved('reviewer');
    const a = (await repo.findById(subagent.id))!;
    const b = (await repo.findById(subagent.id))!;
    const blobsA = publish(a, 1);
    const blobsB = publish(b, 1);
    const results = await Promise.allSettled([repo.save(a, blobsA), repo.save(b, blobsB)]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(results.find((r) => r.status === 'rejected')).toMatchObject({
      reason: { code: 'version_conflict' },
    });
    const rows = await pg.sql`select number from catalog.subagent_versions order by number`;
    expect(rows.map((r) => r.number)).toEqual([1, 2]);
    expect(await pg.sql`select 1 from platform.outbox`).toHaveLength(2);
  });

  it('archives, restores and moves with CAS; checks the target folder', async () => {
    const folder = await devops();
    const subagent = await saved('reviewer');
    const later = new Date(NOW.getTime() + 1000);
    const toArchive = (await repo.findById(subagent.id))!;
    const stale = (await repo.findById(subagent.id))!;
    toArchive.archive(later);
    await repo.save(toArchive, new Map());
    expect(await repo.findById(subagent.id)).toMatchObject({
      status: 'archived',
      updatedAt: later,
    });
    stale.archive(later);
    await expect(repo.save(stale, new Map())).rejects.toMatchObject({ code: 'version_conflict' });

    const intoMissing = (await repo.findById(subagent.id))!;
    intoMissing.restore(NOW);
    unwrap(intoMissing.moveTo({ folderId: randomUUID(), folderSlug: 'x', now: NOW }));
    await expect(repo.save(intoMissing, new Map())).rejects.toMatchObject({
      code: 'folder_not_found',
    });

    const restored = (await repo.findById(subagent.id))!;
    restored.restore(NOW);
    unwrap(restored.moveTo({ folderId: folder.id, folderSlug: 'devops', now: NOW }));
    await repo.save(restored, new Map());
    const [row] = await pg.sql`select status, folder_id, current_version from catalog.subagents`;
    expect(row).toEqual({ status: 'active', folder_id: folder.id, current_version: 1 });
    const types = await pg.sql`select type from platform.outbox order by id`;
    expect(types.map((r) => r.type)).toEqual([
      'catalog.subagent_version_created',
      'catalog.subagent_archived',
      'catalog.subagent_restored',
      'catalog.subagent_moved',
    ]);
  });

  it('refuses a new subagent in an archived or missing folder', async () => {
    const folder = await devops();
    folder.archive(NOW);
    await folders.archiveWithSkills(folder, [], []);
    const a = newSubagent('alpha', {}, folder.id);
    await expect(repo.save(a.subagent, a.blobs)).rejects.toMatchObject({ code: 'folder_archived' });
    const b = newSubagent('beta', {}, randomUUID());
    await expect(repo.save(b.subagent, b.blobs)).rejects.toMatchObject({
      code: 'folder_not_found',
    });
    expect(await pg.sql`select 1 from catalog.subagents`).toHaveLength(0);
    expect(await pg.sql`select 1 from platform.outbox`).toHaveLength(0);
  });

  it('refuses to restore a subagent into an archived folder', async () => {
    const folder = await devops();
    const subagent = await saved('reviewer', {}, folder.id);
    const toArchive = (await repo.findById(subagent.id))!;
    toArchive.archive(NOW);
    await repo.save(toArchive, new Map());
    folder.archive(NOW);
    await folders.archiveWithSkills(folder, [], []);

    const restored = (await repo.findById(subagent.id))!;
    restored.restore(NOW);
    await expect(repo.save(restored, new Map())).rejects.toMatchObject({ code: 'folder_archived' });
    expect(await repo.findById(subagent.id)).toMatchObject({ status: 'archived' });
  });

  it('listSummaries filters by status and folder in one query, with the latest version', async () => {
    const folder = await devops();
    await saved('alpha', { tools: ['Read'], model: 'sonnet', skills: ['x'] });
    const beta = await saved('beta', {}, folder.id);
    const gamma = await saved('gamma', {}, folder.id);
    const loadedBeta = (await repo.findById(beta.id))!;
    await repo.save(loadedBeta, publish(loadedBeta, 1, { description: 'second' }));
    const loadedGamma = (await repo.findById(gamma.id))!;
    loadedGamma.archive(NOW);
    await repo.save(loadedGamma, new Map());

    let queries = 0;
    const counting = new Proxy(pg.sql, {
      apply(target, thisArg, args: Parameters<typeof pg.sql>) {
        queries++;
        return Reflect.apply(target, thisArg, args);
      },
    });
    const all = await new PgSubagentRepository(counting).listSummaries({
      status: 'all',
      folder: null,
    });
    expect(queries).toBe(1);
    expect(all).toEqual([
      {
        slug: 'alpha',
        name: 'alpha',
        description: 'd',
        status: 'active',
        version: 1,
        updatedAt: NOW,
        folder: { slug: 'general', name: 'General' },
        model: 'sonnet',
        tools: ['Read'],
        skills: ['x'],
      },
      expect.objectContaining({ slug: 'beta', version: 2, description: 'second', tools: null }),
      expect.objectContaining({ slug: 'gamma', status: 'archived' }),
    ]);
    const slugs = async (status: 'all' | 'active' | 'archived', f: string | null) =>
      (await repo.listSummaries({ status, folder: f })).map((s) => s.slug);
    expect(await slugs('active', null)).toEqual(['alpha', 'beta']);
    expect(await slugs('archived', null)).toEqual(['gamma']);
    expect(await slugs('all', 'devops')).toEqual(['beta', 'gamma']);
    expect(await slugs('active', 'devops')).toEqual(['beta']);
    expect(await slugs('all', 'nope')).toEqual([]);
    expect((await repo.listActiveInFolder(folder.id)).map((s) => s.slug.value)).toEqual(['beta']);
  });

  it('usedBy lists only active subagents whose latest version names the skill', async () => {
    await saved('zeta', { skills: ['release-runbook', 'other'] });
    await saved('alpha', { skills: ['release-runbook'] });
    const dropped = await saved('dropped', { skills: ['release-runbook'] });
    const archived = await saved('archived-one', { skills: ['release-runbook'] });
    await saved('unrelated', { skills: ['other'] });
    await saved('prefix', { skills: ['release-runbook-v2'] });

    const loadedDropped = (await repo.findById(dropped.id))!;
    await repo.save(loadedDropped, publish(loadedDropped, 1, { skills: ['other'] }));
    const loadedArchived = (await repo.findById(archived.id))!;
    loadedArchived.archive(NOW);
    await repo.save(loadedArchived, new Map());

    expect(await repo.usedBy('release-runbook')).toEqual(['alpha', 'zeta']);
    expect(await repo.usedBy('missing')).toEqual([]);
  });

  it('a subagent and a skill with the same slug live side by side', async () => {
    const bytes = new TextEncoder().encode('skill');
    const hash = nodeHasher.sha256(bytes);
    const skill = unwrap(
      Skill.create({
        id: randomUUID(),
        slug: slug('devops'),
        folderId: GENERAL_FOLDER_ID,
        skillMd: { name: 'devops', description: 'skill', body: '', frontmatter: {} },
        manifest: unwrap(
          SkillManifest.create([
            {
              path: unwrap(FilePath.parse('SKILL.md')),
              hash,
              size: bytes.byteLength,
              binary: false,
            },
          ]),
        ),
        authorId: AUTHOR,
        message: null,
        now: NOW,
        source: null,
        sourceCommit: null,
      }),
    );
    await skills.save(skill, new Map([[hash.value, bytes]]));
    const subagent = await saved('devops', { description: 'agent' });

    expect((await skills.findBySlug(slug('devops')))?.id).toBe(skill.id);
    expect((await repo.findBySlug(slug('devops')))?.id).toBe(subagent.id);
    expect((await repo.findBySlug(slug('devops')))?.latest.description).toBe('agent');
  });
});
