import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vite-plus/test';
import { Folder } from '../../src/modules/catalog/domain/folder.ts';
import { SkillManifest } from '../../src/modules/catalog/domain/manifest.ts';
import { Skill } from '../../src/modules/catalog/domain/skill.ts';
import { Slug } from '../../src/modules/catalog/domain/slug.ts';
import { FilePath } from '../../src/modules/catalog/domain/file-path.ts';
import { nodeHasher } from '../../src/modules/catalog/infrastructure/node-hasher.ts';
import { PgFolderRepository } from '../../src/modules/catalog/infrastructure/pg-folder-repository.ts';
import { PgSkillRepository } from '../../src/modules/catalog/infrastructure/pg-skill-repository.ts';
import { GENERAL_FOLDER_ID, startPg, truncateAll } from '../pg.ts';

let pg: Awaited<ReturnType<typeof startPg>>;
let folders: PgFolderRepository;
let skills: PgSkillRepository;
beforeAll(async () => {
  pg = await startPg();
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
const unwrap = <T>(r: { ok: true; value: T } | { ok: false; error: Error }): T => {
  if (!r.ok) throw r.error;
  return r.value;
};
const slug = (s: string) => unwrap(Slug.parse(s));

function newFolder(s: string, name = s.toUpperCase()) {
  return unwrap(
    Folder.create({ id: randomUUID(), slug: slug(s), name, description: `about ${s}`, now: NOW }),
  );
}

async function newSkill(s: string, folderId: string) {
  const bytes = new TextEncoder().encode(s);
  const hash = nodeHasher.sha256(bytes);
  const manifest = unwrap(
    SkillManifest.create([
      { path: unwrap(FilePath.parse('SKILL.md')), hash, size: bytes.byteLength, binary: false },
    ]),
  );
  const skill = unwrap(
    Skill.create({
      id: randomUUID(),
      slug: slug(s),
      folderId,
      skillMd: { name: s, description: 'd', body: '', frontmatter: {} },
      manifest,
      authorId: randomUUID(),
      message: null,
      now: NOW,
      source: null,
      sourceCommit: null,
    }),
  );
  await skills.save(skill, new Map([[hash.value, bytes]]));
  return skill;
}

describe('PgFolderRepository', () => {
  it('round-trips a folder and finds the default one', async () => {
    const f = newFolder('devops', 'DevOps');
    await folders.save(f);
    const loaded = await folders.findBySlug(slug('devops'));
    expect(loaded).toMatchObject({
      id: f.id,
      name: 'DevOps',
      description: 'about devops',
      status: 'active',
      createdAt: NOW,
      updatedAt: NOW,
    });
    expect((await folders.findById(f.id))?.slug.value).toBe('devops');
    expect(await folders.findById(randomUUID())).toBeNull();
    expect(await folders.findBySlug(slug('nope'))).toBeNull();
    expect((await folders.findById(GENERAL_FOLDER_ID))?.name).toBe('General');

    const later = new Date(NOW.getTime() + 1000);
    unwrap(loaded!.edit({ name: 'Platform', description: 'new', now: later }));
    await folders.save(loaded!);
    expect(await folders.findById(f.id)).toMatchObject({
      name: 'Platform',
      description: 'new',
      updatedAt: later,
    });
  });

  it('rejects a taken slug with folder_exists', async () => {
    await folders.save(newFolder('devops'));
    await expect(folders.save(newFolder('devops'))).rejects.toMatchObject({
      code: 'folder_exists',
    });
    expect(await pg.sql`select 1 from catalog.folders`).toHaveLength(2);
  });

  it('never archives an active folder through save', async () => {
    const f = newFolder('devops');
    await folders.save(f);
    f.archive(NOW);
    await expect(folders.save(f)).rejects.toMatchObject({ code: 'version_conflict' });
    expect((await folders.findById(f.id))?.status).toBe('active');
  });

  it('a stale edit never un-archives a folder', async () => {
    const f = newFolder('devops');
    await folders.save(f);
    await newSkill('a', f.id);
    const stale = (await folders.findById(f.id))!;
    const toArchive = (await folders.findById(f.id))!;
    const active = await skills.listActiveInFolder(f.id);
    toArchive.archive(NOW);
    for (const s of active) s.archive('u', NOW);
    await folders.archiveWithSkills(toArchive, active);

    unwrap(stale.edit({ name: 'Renamed', description: 'about devops', now: NOW }));
    await expect(folders.save(stale)).rejects.toMatchObject({ code: 'version_conflict' });
    expect(await folders.findById(f.id)).toMatchObject({ status: 'archived', name: 'DEVOPS' });

    // A restore is written only over the archived row it was loaded from.
    const restoring = (await folders.findById(f.id))!;
    restoring.restore(NOW);
    await folders.save(restoring, 'archived');
    await expect(folders.save(restoring, 'archived')).rejects.toMatchObject({
      code: 'version_conflict',
    });
    expect((await folders.findById(f.id))?.status).toBe('active');
  });

  it('lists by name with skill counts from one query', async () => {
    const zeta = newFolder('zeta', 'Alpha');
    const beta = newFolder('beta', 'Beta');
    await folders.save(zeta);
    await folders.save(beta);
    await newSkill('a', zeta.id);
    const b = await newSkill('b', zeta.id);
    const loaded = (await skills.findById(b.id))!;
    loaded.archive('u', NOW);
    await skills.save(loaded, new Map());
    beta.archive(NOW);
    await folders.archiveWithSkills(beta, []);

    let queries = 0;
    const counting = new Proxy(pg.sql, {
      apply(target, thisArg, args: Parameters<typeof pg.sql>) {
        queries++;
        return Reflect.apply(target, thisArg, args);
      },
    });
    const all = await new PgFolderRepository(counting).list('all');
    expect(queries).toBe(1);
    expect(all.map((f) => [f.slug, f.status, f.skills])).toEqual([
      ['zeta', 'active', { active: 1, archived: 1 }],
      ['beta', 'archived', { active: 0, archived: 0 }],
      ['general', 'active', { active: 0, archived: 0 }],
    ]);
    expect(all[0]).toMatchObject({ name: 'Alpha', description: 'about zeta' });
    expect((await folders.list('archived')).map((f) => f.slug)).toEqual(['beta']);
    expect((await folders.list('active')).map((f) => f.slug)).toEqual(['zeta', 'general']);
  });

  it('archives a folder with its active skills in one transaction', async () => {
    const f = newFolder('devops');
    await folders.save(f);
    await newSkill('a', f.id);
    await newSkill('b', f.id);
    const active = await skills.listActiveInFolder(f.id);
    f.archive(NOW);
    for (const s of active) s.archive('u', NOW);
    await folders.archiveWithSkills(f, active);
    const rows = await pg.sql`select status from catalog.skills`;
    expect(rows.map((r) => r.status)).toEqual(['archived', 'archived']);
    expect((await folders.findById(f.id))?.status).toBe('archived');
    const archived = await pg.sql`select 1 from platform.outbox
      where type = 'catalog.skill_archived'`;
    expect(archived).toHaveLength(2);
    // Already archived: a second archive is a conflict, not a silent rewrite.
    await expect(folders.archiveWithSkills(f, [])).rejects.toMatchObject({
      code: 'version_conflict',
    });
  });

  it('refuses an incomplete set of skills and writes nothing', async () => {
    const f = newFolder('devops');
    await folders.save(f);
    await newSkill('a', f.id);
    const read = await skills.listActiveInFolder(f.id);
    await newSkill('late', f.id);
    const outbox = (await pg.sql`select 1 from platform.outbox`).length;
    f.archive(NOW);
    for (const s of read) s.archive('u', NOW);
    await expect(folders.archiveWithSkills(f, read)).rejects.toMatchObject({
      code: 'version_conflict',
    });
    expect((await folders.findById(f.id))?.status).toBe('active');
    const rows = await pg.sql`select status from catalog.skills`;
    expect(rows.map((r) => r.status)).toEqual(['active', 'active']);
    expect(await pg.sql`select 1 from platform.outbox`).toHaveLength(outbox);
  });

  it('refuses a skill changed since it was read', async () => {
    const f = newFolder('devops');
    await folders.save(f);
    const a = await newSkill('a', f.id);
    const [read] = await skills.listActiveInFolder(f.id);
    // Same id set, but a new version was published meanwhile: the current_version CAS fails.
    const winner = (await skills.findById(a.id))!;
    const bytes = new TextEncoder().encode('v2');
    const hash = nodeHasher.sha256(bytes);
    unwrap(
      winner.publish({
        baseVersion: 1,
        skillMd: { name: 'a', description: 'd', body: '', frontmatter: {} },
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
        authorId: randomUUID(),
        message: null,
        now: NOW,
        sourceCommit: null,
      }),
    );
    await skills.save(winner, new Map([[hash.value, bytes]]));
    f.archive(NOW);
    read!.archive('u', NOW);
    await expect(folders.archiveWithSkills(f, [read!])).rejects.toMatchObject({
      code: 'version_conflict',
    });
    expect((await folders.findById(f.id))?.status).toBe('active');
  });
});
