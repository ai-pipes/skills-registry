import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vite-plus/test';
import { CatalogError } from '../../src/modules/catalog/domain/errors.ts';
import { Folder } from '../../src/modules/catalog/domain/folder.ts';
import { FilePath } from '../../src/modules/catalog/domain/file-path.ts';
import { SkillManifest } from '../../src/modules/catalog/domain/manifest.ts';
import { Skill } from '../../src/modules/catalog/domain/skill.ts';
import { Slug } from '../../src/modules/catalog/domain/slug.ts';
import { nodeHasher } from '../../src/modules/catalog/infrastructure/node-hasher.ts';
import { PgBlobStore } from '../../src/modules/catalog/infrastructure/pg-blob-store.ts';
import { PgFolderRepository } from '../../src/modules/catalog/infrastructure/pg-folder-repository.ts';
import { PgSkillRepository } from '../../src/modules/catalog/infrastructure/pg-skill-repository.ts';
import { GENERAL_FOLDER_ID, startPg, truncateAll } from '../pg.ts';

let pg: Awaited<ReturnType<typeof startPg>>;
let repo: PgSkillRepository;
let folders: PgFolderRepository;
beforeAll(async () => {
  pg = await startPg();
  repo = new PgSkillRepository(pg.sql);
  folders = new PgFolderRepository(pg.sql);
});
afterAll(async () => {
  await pg.stop();
});
beforeEach(async () => {
  await truncateAll(pg.sql);
});

const NOW = new Date('2026-01-01T00:00:00Z');
const AUTHOR = randomUUID();
const enc = (s: string) => new TextEncoder().encode(s);
const unwrap = <T>(r: { ok: true; value: T } | { ok: false; error: Error }): T => {
  if (!r.ok) throw r.error;
  return r.value;
};
const md = (name: string) => ({ name, description: 'd', body: '', frontmatter: {} });

function content(files: Record<string, string>) {
  const blobs = new Map<string, Uint8Array>();
  const entries = Object.entries(files).map(([path, text]) => {
    const bytes = enc(text);
    const hash = nodeHasher.sha256(bytes);
    blobs.set(hash.value, bytes);
    return { path: unwrap(FilePath.parse(path)), hash, size: bytes.byteLength, binary: false };
  });
  return { blobs, manifest: unwrap(SkillManifest.create(entries)) };
}

function newSkill(slug: string, files: Record<string, string>, folderId = GENERAL_FOLDER_ID) {
  const { blobs, manifest } = content(files);
  const skill = unwrap(
    Skill.create({
      id: randomUUID(),
      slug: unwrap(Slug.parse(slug)),
      folderId,
      skillMd: md(slug),
      manifest,
      authorId: AUTHOR,
      message: 'first',
      now: NOW,
      source: null,
      sourceCommit: null,
    }),
  );
  return { skill, blobs };
}

function publish(skill: Skill, base: number, files: Record<string, string>) {
  const { blobs, manifest } = content(files);
  unwrap(
    skill.publish({
      baseVersion: base,
      skillMd: md(skill.slug.value),
      manifest,
      authorId: AUTHOR,
      message: 'next',
      sourceCommit: null,
      now: NOW,
    }),
  );
  return blobs;
}

async function devops(status: 'active' | 'archived' = 'active') {
  const folder = unwrap(
    Folder.create({
      id: randomUUID(),
      slug: unwrap(Slug.parse('devops')),
      name: 'DevOps',
      description: 'ops',
      now: NOW,
    }),
  );
  await folders.save(folder);
  if (status === 'archived') {
    folder.archive(NOW);
    await folders.archiveWithSkills(folder, []);
  }
  return folder;
}

describe('PgSkillRepository', () => {
  it('writes the source on create and on a synced version only; reads the stored host', async () => {
    const { blobs, manifest } = content({ 'SKILL.md': 'v1' });
    const source = { host: 'github.com', repo: 'o/r', path: 'x', ref: 'main' } as const;
    const skill = unwrap(
      Skill.create({
        id: randomUUID(),
        slug: unwrap(Slug.parse('alpha')),
        folderId: GENERAL_FOLDER_ID,
        skillMd: md('alpha'),
        manifest,
        authorId: AUTHOR,
        message: 'first',
        now: NOW,
        source,
        sourceCommit: '1'.repeat(40),
      }),
    );
    await repo.save(skill, blobs);
    const loaded = (await repo.findById(skill.id))!;
    expect(loaded.source).toEqual({ ...source, syncedVersion: 1 });
    // Changed after the load: a version without sourceCommit must not write it back.
    await pg.sql`update catalog.skill_sources set ref = 'elsewhere'`;
    await repo.save(loaded, publish(loaded, 1, { 'SKILL.md': 'v2' }));
    const rows = await pg.sql`select host, ref, synced_version from catalog.skill_sources`;
    expect(rows).toEqual([{ host: 'github.com', ref: 'elsewhere', synced_version: 1 }]);
  });

  it('round-trips a skill with files', async () => {
    const { skill, blobs } = newSkill('alpha', { 'SKILL.md': 'hello', 'ref/a.txt': 'aaa' });
    await repo.save(skill, blobs);

    const loaded = await repo.findBySlug(skill.slug);
    expect(loaded?.id).toBe(skill.id);
    expect(loaded?.status).toBe('active');
    expect(loaded?.currentVersion).toBe(1);
    expect(loaded?.latest.authorId).toBe(AUTHOR);
    expect(loaded?.latest.message).toBe('first');
    expect(loaded?.latest.manifest.entries.map((e) => e.path.value)).toEqual([
      'SKILL.md',
      'ref/a.txt',
    ]);
    expect((await repo.findById(skill.id))?.slug.value).toBe('alpha');
    expect(await repo.findById(randomUUID())).toBeNull();

    const hash = loaded!.latest.manifest.entries[0]!.hash;
    const bytes = await new PgBlobStore(pg.sql).get(hash);
    expect(new TextDecoder().decode(bytes)).toBe('hello');
  });

  it('lists versions and scopes getVersion by skill', async () => {
    const { skill, blobs } = newSkill('alpha', { 'SKILL.md': 'v1' });
    await repo.save(skill, blobs);
    const loaded = (await repo.findById(skill.id))!;
    const b2 = publish(loaded, 1, { 'SKILL.md': 'v2' });
    await repo.save(loaded, b2);

    expect((await repo.listVersions(skill.id)).map((v) => v.number)).toEqual([1, 2]);
    expect((await repo.getVersion(skill.id, 2))?.number).toBe(2);
    expect(await repo.getVersion(skill.id, 3)).toBeNull();
    expect(await repo.getVersion(randomUUID(), 1)).toBeNull();
  });

  it('persists status changes and filters by status', async () => {
    const a = newSkill('alpha', { 'SKILL.md': 'a' });
    const b = newSkill('beta', { 'SKILL.md': 'b' });
    await repo.save(a.skill, a.blobs);
    await repo.save(b.skill, b.blobs);
    const loaded = (await repo.findById(a.skill.id))!;
    loaded.archive(AUTHOR, NOW);
    await repo.save(loaded, new Map());

    const slugs = async (status: 'all' | 'active' | 'archived') =>
      (await repo.listSummaries({ status, folder: null })).map((s) => s.slug);
    expect(await slugs('all')).toEqual(['alpha', 'beta']);
    expect(await slugs('active')).toEqual(['beta']);
    expect(await slugs('archived')).toEqual(['alpha']);
  });

  it('stores updatedAt from the aggregate: publish and status changes move it', async () => {
    const { skill, blobs } = newSkill('alpha', { 'SKILL.md': 'v1' });
    await repo.save(skill, blobs);
    const later = new Date(NOW.getTime() + 60_000);
    const loaded = (await repo.findById(skill.id))!;
    expect(loaded.updatedAt).toEqual(NOW);
    loaded.archive(AUTHOR, later);
    await repo.save(loaded, new Map());
    expect((await repo.findById(skill.id))!.updatedAt).toEqual(later);
    expect(await repo.listSummaries({ status: 'all', folder: null })).toEqual([
      {
        slug: 'alpha',
        name: 'alpha',
        description: 'd',
        status: 'archived',
        version: 1,
        updatedAt: later,
        folder: { slug: 'general', name: 'General' },
      },
    ]);
  });

  it('listSummaries reads 50 skills with exactly one query and the latest version', async () => {
    const created = Array.from({ length: 50 }, (_, i) =>
      newSkill(`s-${String(i).padStart(2, '0')}`, { 'SKILL.md': `v${i}` }),
    );
    await Promise.all(created.map(({ skill, blobs }) => repo.save(skill, blobs)));
    const first = (await repo.findById(created[0]!.skill.id))!;
    const b2 = publish(first, 1, { 'SKILL.md': 'second' });
    await repo.save(first, b2);

    let queries = 0;
    const counting = new Proxy(pg.sql, {
      apply(target, thisArg, args: Parameters<typeof pg.sql>) {
        queries++;
        return Reflect.apply(target, thisArg, args);
      },
    });
    const summaries = await new PgSkillRepository(counting).listSummaries({
      status: 'all',
      folder: null,
    });
    expect(queries).toBe(1);
    expect(summaries).toHaveLength(50);
    expect(summaries[0]).toMatchObject({ slug: 's-00', version: 2, status: 'active' });
    expect(summaries[49]).toMatchObject({ slug: 's-49', version: 1, name: 's-49' });
  });

  it('stores identical files once', async () => {
    const { skill, blobs } = newSkill('alpha', { 'SKILL.md': 'same', 'x.txt': 'x' });
    await repo.save(skill, blobs);
    const loaded = (await repo.findById(skill.id))!;
    const b2 = publish(loaded, 1, { 'SKILL.md': 'same', 'y.txt': 'y' });
    await repo.save(loaded, b2);

    const blobCount = await pg.sql`select hash from catalog.blobs`;
    expect(blobCount).toHaveLength(3);
    expect(await pg.sql`select path from catalog.version_files`).toHaveLength(4);
  });

  it('writes outbox in the same transaction', async () => {
    const { skill, blobs } = newSkill('alpha', { 'SKILL.md': 'a' });
    await repo.save(skill, blobs);
    const rows = await pg.sql`select type, payload from platform.outbox`;
    expect(rows.map((r) => r.type)).toEqual(['catalog.skill_version_created']);
    expect(rows[0]?.payload).toMatchObject({ slug: 'alpha', version: 1 });

    const dup = newSkill('alpha', { 'SKILL.md': 'other' });
    await expect(repo.save(dup.skill, dup.blobs)).rejects.toMatchObject({ code: 'skill_exists' });
    expect(await pg.sql`select 1 from catalog.skills`).toHaveLength(1);
    expect(await pg.sql`select 1 from platform.outbox`).toHaveLength(1);
    expect(await pg.sql`select 1 from catalog.blobs`).toHaveLength(1);
  });

  it('rejects concurrent publishes', async () => {
    const { skill, blobs } = newSkill('alpha', { 'SKILL.md': 'v1' });
    await repo.save(skill, blobs);
    const a = (await repo.findById(skill.id))!;
    const b = (await repo.findById(skill.id))!;
    const blobsA = publish(a, 1, { 'SKILL.md': 'from a' });
    const blobsB = publish(b, 1, { 'SKILL.md': 'from b' });

    const results = await Promise.allSettled([repo.save(a, blobsA), repo.save(b, blobsB)]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const rejected = results.find((r) => r.status === 'rejected');
    expect(rejected).toBeDefined();
    expect(rejected).toMatchObject({ reason: expect.any(CatalogError) });
    expect(rejected).toMatchObject({ reason: { code: 'version_conflict' } });

    const rows = await pg.sql<{ number: number }[]>`
      select number from catalog.skill_versions order by number`;
    expect(rows.map((r) => r.number)).toEqual([1, 2]);
    expect(await pg.sql`select 1 from platform.outbox`).toHaveLength(2);
  });

  it('archive concurrent with publish loses neither', async () => {
    const { skill, blobs } = newSkill('alpha', { 'SKILL.md': 'v1' });
    await repo.save(skill, blobs);
    const toArchive = (await repo.findById(skill.id))!;
    const toPublish = (await repo.findById(skill.id))!;
    toArchive.archive(AUTHOR, NOW);
    const pubBlobs = publish(toPublish, 1, { 'SKILL.md': 'v2' });

    const results = await Promise.allSettled([
      repo.save(toArchive, new Map()),
      repo.save(toPublish, pubBlobs),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const rejected = results.find((r) => r.status === 'rejected');
    expect(rejected).toMatchObject({ reason: { code: 'version_conflict' } });

    const [row] = await pg.sql`select status, current_version from catalog.skills`;
    const state = `${row?.status}@${row?.current_version}`;
    expect(['archived@1', 'active@2']).toContain(state);
    expect(await pg.sql`select 1 from platform.outbox`).toHaveLength(2);
  });

  it('archive writes outbox row and keeps current_version', async () => {
    const { skill, blobs } = newSkill('alpha', { 'SKILL.md': 'v1' });
    await repo.save(skill, blobs);
    const loaded = (await repo.findById(skill.id))!;
    loaded.archive(AUTHOR, NOW);
    await repo.save(loaded, new Map());

    const types = await pg.sql`select type from platform.outbox order by id`;
    expect(types.map((r) => r.type)).toEqual([
      'catalog.skill_version_created',
      'catalog.skill_archived',
    ]);
    const [row] = await pg.sql`select status, current_version from catalog.skills`;
    expect(row).toMatchObject({ status: 'archived', current_version: 1 });

    const stale = (await repo.findById(skill.id))!;
    stale.restore(AUTHOR, NOW);
    const other = (await repo.findById(skill.id))!;
    other.restore(AUTHOR, NOW);
    await repo.save(stale, new Map());
    await expect(repo.save(other, new Map())).rejects.toMatchObject({ code: 'version_conflict' });
    expect(await pg.sql`select 1 from platform.outbox`).toHaveLength(3);
  });
  it('stores and reads folder_id; filters summaries by folder slug', async () => {
    const folder = await devops();
    const a = newSkill('alpha', { 'SKILL.md': 'a' });
    const b = newSkill('beta', { 'SKILL.md': 'b' }, folder.id);
    await repo.save(a.skill, a.blobs);
    await repo.save(b.skill, b.blobs);
    expect((await repo.findById(a.skill.id))?.folderId).toBe(GENERAL_FOLDER_ID);
    expect((await repo.findBySlug(b.skill.slug))?.folderId).toBe(folder.id);
    const inDevops = await repo.listSummaries({ status: 'all', folder: 'devops' });
    expect(inDevops.map((s) => [s.slug, s.folder])).toEqual([
      ['beta', { slug: 'devops', name: 'DevOps' }],
    ]);
    expect(await repo.listSummaries({ status: 'all', folder: 'nope' })).toEqual([]);
    expect((await repo.listActiveInFolder(folder.id)).map((s) => s.slug.value)).toEqual(['beta']);
  });

  it('refuses a new skill in an archived or missing folder', async () => {
    const folder = await devops('archived');
    const a = newSkill('alpha', { 'SKILL.md': 'a' }, folder.id);
    await expect(repo.save(a.skill, a.blobs)).rejects.toMatchObject({ code: 'folder_archived' });
    const b = newSkill('beta', { 'SKILL.md': 'b' }, randomUUID());
    await expect(repo.save(b.skill, b.blobs)).rejects.toMatchObject({ code: 'folder_not_found' });
    expect(await pg.sql`select 1 from catalog.skills`).toHaveLength(0);
    expect(await pg.sql`select 1 from platform.outbox`).toHaveLength(0);
  });

  it('moves a skill: folder_id and catalog.skill_moved in the outbox, same version', async () => {
    const folder = await devops();
    const { skill, blobs } = newSkill('alpha', { 'SKILL.md': 'a' });
    await repo.save(skill, blobs);
    const later = new Date(NOW.getTime() + 1000);
    const loaded = (await repo.findById(skill.id))!;
    unwrap(loaded.moveTo({ folderId: folder.id, folderSlug: 'devops', now: later }));
    await repo.save(loaded, new Map());
    const [row] = await pg.sql`select folder_id, current_version, updated_at from catalog.skills`;
    expect(row).toMatchObject({ folder_id: folder.id, current_version: 1, updated_at: later });
    const [moved] = await pg.sql`select payload from platform.outbox
      where type = 'catalog.skill_moved'`;
    expect(moved?.payload).toEqual({ skillId: skill.id, slug: 'alpha', folder: 'devops' });

    const stale = (await repo.findById(skill.id))!;
    const winner = (await repo.findById(skill.id))!;
    winner.archive(AUTHOR, later);
    await repo.save(winner, new Map());
    unwrap(stale.moveTo({ folderId: GENERAL_FOLDER_ID, folderSlug: 'general', now: later }));
    await expect(repo.save(stale, new Map())).rejects.toMatchObject({ code: 'version_conflict' });
  });

  it('archive loaded before a move cannot write the old folder back', async () => {
    const folder = await devops();
    const { skill, blobs } = newSkill('alpha', { 'SKILL.md': 'a' });
    await repo.save(skill, blobs);
    const toArchive = (await repo.findById(skill.id))!;
    const mover = (await repo.findById(skill.id))!;
    unwrap(mover.moveTo({ folderId: folder.id, folderSlug: 'devops', now: NOW }));
    await repo.save(mover, new Map());
    toArchive.archive(AUTHOR, NOW);
    await expect(repo.save(toArchive, new Map())).rejects.toMatchObject({
      code: 'version_conflict',
    });
    const [row] = await pg.sql`select folder_id, status from catalog.skills`;
    expect(row).toMatchObject({ folder_id: folder.id, status: 'active' });
  });

  it('restores and moves in one save: both outbox rows; checks the target folder', async () => {
    const folder = await devops();
    const { skill, blobs } = newSkill('alpha', { 'SKILL.md': 'a' });
    await repo.save(skill, blobs);
    const archived = (await repo.findById(skill.id))!;
    archived.archive(AUTHOR, NOW);
    await repo.save(archived, new Map());

    const intoMissing = (await repo.findById(skill.id))!;
    intoMissing.restore(AUTHOR, NOW);
    unwrap(intoMissing.moveTo({ folderId: randomUUID(), folderSlug: 'x', now: NOW }));
    await expect(repo.save(intoMissing, new Map())).rejects.toMatchObject({
      code: 'folder_not_found',
    });

    const loaded = (await repo.findById(skill.id))!;
    loaded.restore(AUTHOR, NOW);
    unwrap(loaded.moveTo({ folderId: folder.id, folderSlug: 'devops', now: NOW }));
    await repo.save(loaded, new Map());
    const types = await pg.sql`select type from platform.outbox order by id`;
    expect(types.map((r) => r.type)).toEqual([
      'catalog.skill_version_created',
      'catalog.skill_archived',
      'catalog.skill_restored',
      'catalog.skill_moved',
    ]);
    const [row] = await pg.sql`select status, folder_id from catalog.skills`;
    expect(row).toMatchObject({ status: 'active', folder_id: folder.id });
  });
});
