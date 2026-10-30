import { beforeEach, describe, expect, it } from 'vite-plus/test';
import { type Audited, makeCatalogDeps } from '../../../../test/fakes/catalog-deps.ts';
import type { FixedClock } from '../../../../test/fakes/fixed-clock.ts';
import type { InMemoryFolderRepository } from '../../../../test/fakes/in-memory-folder-repository.ts';
import type { InMemorySkillRepository } from '../../../../test/fakes/in-memory-skill-repository.ts';
import { CatalogError } from '../domain/errors.ts';
import { Slug } from '../domain/slug.ts';
import { archiveSkill, restoreSkill } from './commands/archive.ts';
import { createSkill } from './commands/create-skill.ts';
import { archiveFolder, createFolder, restoreFolder, updateFolder } from './commands/folders.ts';
import { moveSkill } from './commands/move-skill.ts';
import type { CatalogDeps } from './deps.ts';
import type { FolderRepository } from './ports.ts';
import { getSkill } from './queries/get-skill.ts';
import { listFolders } from './queries/list-folders.ts';
import { listSkills } from './queries/list-skills.ts';

const enc = (s: string) => new TextEncoder().encode(s);
const md = (name: string) => enc(`---\nname: ${name}\ndescription: does things\n---\nbody\n`);

let deps: CatalogDeps;
let skills: InMemorySkillRepository;
let folders: InMemoryFolderRepository;
let audit: Audited[];
let clock: FixedClock;

beforeEach(() => {
  ({ deps, skills, folders, audit, clock } = makeCatalogDeps());
});

const create = (slug: string, folder = 'general') =>
  createSkill(deps, {
    slug,
    folder,
    files: [{ path: 'SKILL.md', bytes: md(slug) }],
    actorId: 'u',
    message: null,
    source: null,
    sourceCommit: null,
  });
const newFolder = (slug: string, name = slug.toUpperCase(), description = 'about ' + slug) =>
  createFolder(deps, { slug, name, description, actorId: 'u' });
const code = (r: { ok: boolean; error?: CatalogError } | { ok: true; value: unknown }) =>
  !r.ok && 'error' in r ? r.error?.code : 'ok';
const statusOf = async (slug: string) => {
  const v = await getSkill(deps, { slug });
  if (!v.ok) throw v.error;
  return v.value.status;
};
const statuses = (slugs: string[]) => Promise.all(slugs.map(statusOf));
const actions = () => audit.map((e) => e.action);

describe('createSkill in a folder', () => {
  it('requires an existing, active folder', async () => {
    expect(code(await create('a', 'nope'))).toBe('folder_not_found');
    expect(code(await create('a', 'Bad Folder'))).toBe('invalid_slug');
    await newFolder('old');
    await archiveFolder(deps, { slug: 'old', actorId: 'u' });
    expect(code(await create('a', 'old'))).toBe('folder_archived');
    audit.length = 0;
    expect(code(await create('a'))).toBe('ok');
    const [s] = await listSkills(deps, { status: 'active' });
    expect(s?.folder).toEqual({ slug: 'general', name: 'General' });
    expect(audit).toEqual([
      {
        actorId: 'u',
        action: 'skill.create',
        target: 'a',
        meta: { version: 1, folder: 'general' },
      },
    ]);
  });

  it('checks the skill slug before the folder', async () => {
    await create('a');
    expect(code(await create('a', 'nope'))).toBe('skill_exists');
    expect(code(await create('new', 'nope'))).toBe('invalid_slug');
  });

  it('lists only the skills of a folder when asked', async () => {
    await newFolder('devops');
    await create('a');
    await create('b', 'devops');
    const inDevops = await listSkills(deps, { status: 'all', folder: 'devops' });
    expect(inDevops.map((s) => s.slug)).toEqual(['b']);
    expect(await listSkills(deps, { status: 'all', folder: 'nope' })).toEqual([]);
    expect(await listSkills(deps, { status: 'all' })).toHaveLength(2);
  });
});

describe('createFolder / updateFolder / listFolders', () => {
  it('creates a folder once and rejects reserved or invalid input', async () => {
    expect(await newFolder('devops')).toEqual({
      ok: true,
      value: { slug: 'devops', name: 'DEVOPS' },
    });
    expect(code(await newFolder('devops'))).toBe('folder_exists');
    expect(code(await newFolder('new'))).toBe('invalid_slug');
    expect(code(await newFolder('Bad'))).toBe('invalid_slug');
    expect(code(await newFolder('x', '  '))).toBe('invalid_folder');
    expect(audit).toEqual([{ actorId: 'u', action: 'folder.create', target: 'devops' }]);
  });

  it('renames a folder; skills show the new name', async () => {
    await newFolder('devops', 'DevOps', 'ops');
    await create('a', 'devops');
    const r = await updateFolder(deps, {
      slug: 'devops',
      name: ' Platform ',
      description: 'ops',
      actorId: 'u',
    });
    expect(r).toEqual({ ok: true, value: { slug: 'devops', name: 'Platform' } });
    const [s] = await listSkills(deps, { status: 'all' });
    expect(s?.folder).toEqual({ slug: 'devops', name: 'Platform' });
    const view = await getSkill(deps, { slug: 'a' });
    expect(view.ok && view.value.folder).toEqual({ slug: 'devops', name: 'Platform' });
    expect(actions()).toEqual(['folder.create', 'skill.create', 'folder.update']);
  });

  it('does not audit an update that changes nothing; reports errors', async () => {
    await newFolder('devops', 'DevOps', 'ops');
    const same = await updateFolder(deps, {
      slug: 'devops',
      name: 'DevOps',
      description: 'ops',
      actorId: 'u',
    });
    expect(same.ok).toBe(true);
    expect(actions()).toEqual(['folder.create']);
    const cmd = { name: 'n', description: 'd', actorId: 'u' };
    expect(code(await updateFolder(deps, { ...cmd, slug: 'nope' }))).toBe('folder_not_found');
    expect(code(await updateFolder(deps, { ...cmd, slug: 'BAD' }))).toBe('invalid_slug');
    expect(code(await updateFolder(deps, { ...cmd, slug: 'devops', name: '' }))).toBe(
      'invalid_folder',
    );
  });

  it('lists folders by name with skill counts', async () => {
    await newFolder('zeta', 'Alpha');
    await newFolder('beta', 'Beta');
    await create('a', 'zeta');
    await create('b', 'zeta');
    await archiveSkill(deps, { slug: 'b', actorId: 'u' });
    await archiveFolder(deps, { slug: 'beta', actorId: 'u' });
    const all = await listFolders(deps, { status: 'all' });
    expect(all.map((f) => [f.slug, f.skills])).toEqual([
      ['zeta', { active: 1, archived: 1 }],
      ['beta', { active: 0, archived: 0 }],
      ['general', { active: 0, archived: 0 }],
    ]);
    expect(all[0]).toMatchObject({ name: 'Alpha', description: 'about zeta', status: 'active' });
    const archived = await listFolders(deps, { status: 'archived' });
    expect(archived.map((f) => f.slug)).toEqual(['beta']);
  });
});

describe('moveSkill', () => {
  beforeEach(async () => {
    await newFolder('devops');
    await create('a');
    audit.length = 0;
  });

  it('moves a skill without a new version', async () => {
    clock.advance(1000);
    expect(await moveSkill(deps, { slug: 'a', folder: 'devops', actorId: 'u' })).toEqual({
      ok: true,
      value: undefined,
    });
    const view = await getSkill(deps, { slug: 'a' });
    if (!view.ok) throw view.error;
    expect(view.value.folder.slug).toBe('devops');
    expect(view.value.version).toBe(1);
    expect(view.value.updatedAt.toISOString()).toBe('2026-01-01T00:00:01.000Z');
    expect(audit).toEqual([
      { actorId: 'u', action: 'skill.move', target: 'a', meta: { from: 'general', to: 'devops' } },
    ]);
    expect(skills.outbox.at(-1)?.type).toBe('catalog.skill_moved');
    expect(skills.outbox.at(-1)?.payload).toMatchObject({ slug: 'a', folder: 'devops' });
  });

  it('is a no-op into the same folder', async () => {
    const events = skills.outbox.length;
    clock.advance(1000);
    expect((await moveSkill(deps, { slug: 'a', folder: 'general', actorId: 'u' })).ok).toBe(true);
    expect(audit).toEqual([]);
    expect(skills.outbox).toHaveLength(events);
    const view = await getSkill(deps, { slug: 'a' });
    expect(view.ok && view.value.updatedAt.toISOString()).toBe('2026-01-01T00:00:00.000Z');
  });

  it('rejects unknown skills and folders, archived skills and folders', async () => {
    const mv = (slug: string, to: string) => moveSkill(deps, { slug, folder: to, actorId: 'u' });
    expect(code(await mv('BAD', 'devops'))).toBe('invalid_slug');
    expect(code(await mv('nope', 'devops'))).toBe('skill_not_found');
    expect(code(await mv('a', 'BAD'))).toBe('invalid_slug');
    expect(code(await mv('a', 'nope'))).toBe('folder_not_found');
    await newFolder('old');
    await archiveFolder(deps, { slug: 'old', actorId: 'u' });
    expect(code(await mv('a', 'old'))).toBe('folder_archived');
    await archiveSkill(deps, { slug: 'a', actorId: 'u' });
    expect(code(await mv('a', 'old'))).toBe('skill_archived');
    expect(code(await mv('a', 'devops'))).toBe('skill_archived');
    expect(actions()).not.toContain('skill.move');
  });

  it('surfaces a lost race as a Result', async () => {
    const racing: CatalogDeps = {
      ...deps,
      skills: {
        findBySlug: (s) => skills.findBySlug(s),
        findById: (i) => skills.findById(i),
        getVersion: (i, n) => skills.getVersion(i, n),
        listVersions: (i) => skills.listVersions(i),
        listSummaries: (f) => skills.listSummaries(f),
        listActiveInFolder: (i) => skills.listActiveInFolder(i),
        save: async () => {
          throw new CatalogError('version_conflict', 'lost');
        },
      },
    };
    const r = await moveSkill(racing, { slug: 'a', folder: 'devops', actorId: 'u' });
    expect(code(r)).toBe('version_conflict');
    expect(audit).toEqual([]);
  });
});

/** The folder fake whose archiveWithSkills loses the first `failures` races. */
const flaky = (failures: number): FolderRepository => {
  let left = failures;
  return {
    findBySlug: (s) => folders.findBySlug(s),
    findById: (i) => folders.findById(i),
    list: (s) => folders.list(s),
    save: (f) => folders.save(f),
    archiveWithSkills: async (f, s) => {
      if (left > 0) {
        left -= 1;
        throw new CatalogError('version_conflict', 'concurrent');
      }
      return folders.archiveWithSkills(f, s);
    },
  };
};

describe('archiveFolder / restoreFolder', () => {
  beforeEach(async () => {
    await newFolder('devops');
    await create('a', 'devops');
    await create('b', 'devops');
    await create('c', 'devops');
    await create('other');
    await archiveSkill(deps, { slug: 'c', actorId: 'u' });
    audit.length = 0;
  });

  it('archives the folder and its active skills in one write', async () => {
    const before = skills.outbox.length;
    expect(await archiveFolder(deps, { slug: 'devops', actorId: 'u' })).toEqual({
      ok: true,
      value: { archivedSkills: 2 },
    });
    expect(await statuses(['a', 'b', 'c'])).toEqual(['archived', 'archived', 'archived']);
    expect(await statusOf('other')).toBe('active');
    const events = skills.outbox.slice(before);
    expect(events.map((e) => e.type)).toEqual(['catalog.skill_archived', 'catalog.skill_archived']);
    expect(audit).toEqual([
      { actorId: 'u', action: 'folder.archive', target: 'devops', meta: { archivedSkills: 2 } },
      {
        actorId: 'u',
        action: 'skill.archive',
        target: 'a',
        meta: { version: 1, viaFolder: 'devops' },
      },
      {
        actorId: 'u',
        action: 'skill.archive',
        target: 'b',
        meta: { version: 1, viaFolder: 'devops' },
      },
    ]);
    const [f] = await listFolders(deps, { status: 'archived' });
    expect(f).toMatchObject({ slug: 'devops', status: 'archived' });

    expect(await archiveFolder(deps, { slug: 'devops', actorId: 'u' })).toEqual({
      ok: true,
      value: { archivedSkills: 0 },
    });
    expect(audit).toHaveLength(3);
  });

  it('restores only the folder', async () => {
    await archiveFolder(deps, { slug: 'devops', actorId: 'u' });
    expect(await restoreFolder(deps, { slug: 'devops', actorId: 'u' })).toEqual({
      ok: true,
      value: undefined,
    });
    const f = (await listFolders(deps, { status: 'all' })).find((x) => x.slug === 'devops');
    expect(f?.status).toBe('active');
    expect(await statuses(['a', 'b', 'c'])).toEqual(['archived', 'archived', 'archived']);
    expect(actions().at(-1)).toBe('folder.restore');
    const n = audit.length;
    expect((await restoreFolder(deps, { slug: 'devops', actorId: 'u' })).ok).toBe(true);
    expect(audit).toHaveLength(n);
  });

  it('reports unknown and invalid folders', async () => {
    const runs = [archiveFolder, restoreFolder].flatMap((run) =>
      ['nope', 'BAD'].map((slug) => run(deps, { slug, actorId: 'u' })),
    );
    expect((await Promise.all(runs)).map(code)).toEqual([
      'folder_not_found',
      'invalid_slug',
      'folder_not_found',
      'invalid_slug',
    ]);
  });

  it('a stale updateFolder never un-archives the folder', async () => {
    const slug = Slug.parse('devops');
    if (!slug.ok) throw slug.error;
    const stale = await folders.findBySlug(slug.value);
    await archiveFolder(deps, { slug: 'devops', actorId: 'u' });
    audit.length = 0;
    const racing: FolderRepository = { ...flaky(0), findBySlug: async () => stale };
    const r = await updateFolder(
      { ...deps, folders: racing },
      { slug: 'devops', name: 'Renamed', description: 'x', actorId: 'u' },
    );
    expect(code(r)).toBe('version_conflict');
    const f = (await listFolders(deps, { status: 'all' })).find((x) => x.slug === 'devops');
    expect(f).toMatchObject({ status: 'archived', name: 'DEVOPS' });
    expect(audit).toEqual([]);
  });

  it('retries a version_conflict up to three attempts', async () => {
    const r = await archiveFolder({ ...deps, folders: flaky(2) }, { slug: 'devops', actorId: 'u' });
    expect(r).toEqual({ ok: true, value: { archivedSkills: 2 } });
    expect(await statusOf('a')).toBe('archived');
  });

  it('gives up after three conflicts', async () => {
    const r = await archiveFolder({ ...deps, folders: flaky(3) }, { slug: 'devops', actorId: 'u' });
    expect(code(r)).toBe('version_conflict');
    expect(await statusOf('a')).toBe('active');
    expect(audit).toEqual([]);
  });

  it('picks up a skill created between the read and the write', async () => {
    let raced = false;
    const racing: FolderRepository = {
      ...flaky(0),
      archiveWithSkills: async (f, s) => {
        if (!raced) {
          raced = true;
          await create('late', 'devops');
        }
        return folders.archiveWithSkills(f, s);
      },
    };
    const r = await archiveFolder({ ...deps, folders: racing }, { slug: 'devops', actorId: 'u' });
    expect(r).toEqual({ ok: true, value: { archivedSkills: 3 } });
    expect(await statusOf('late')).toBe('archived');
  });

  it('rethrows unexpected errors', async () => {
    const broken: FolderRepository = {
      ...flaky(0),
      archiveWithSkills: async () => {
        throw new Error('db down');
      },
    };
    await expect(
      archiveFolder({ ...deps, folders: broken }, { slug: 'devops', actorId: 'u' }),
    ).rejects.toThrow('db down');
  });
});

describe('restoreSkill and folders', () => {
  beforeEach(async () => {
    await newFolder('devops');
    await create('a', 'devops');
    await archiveFolder(deps, { slug: 'devops', actorId: 'u' });
    audit.length = 0;
  });

  it('refuses to restore into an archived folder', async () => {
    const r = await restoreSkill(deps, { slug: 'a', actorId: 'u' });
    expect(!r.ok && r.error).toMatchObject({
      code: 'folder_archived',
      message: 'folder "devops" is archived',
    });
    expect(await statusOf('a')).toBe('archived');
    expect(audit).toEqual([]);
  });

  it('restores into another folder with one save', async () => {
    const before = skills.outbox.length;
    const r = await restoreSkill(deps, { slug: 'a', actorId: 'u', folder: 'general' });
    expect(r).toEqual({ ok: true, value: undefined });
    const view = await getSkill(deps, { slug: 'a' });
    expect(view.ok && [view.value.status, view.value.folder.slug]).toEqual(['active', 'general']);
    expect(skills.outbox.slice(before).map((e) => e.type)).toEqual([
      'catalog.skill_restored',
      'catalog.skill_moved',
    ]);
    expect(audit).toEqual([
      { actorId: 'u', action: 'skill.restore', target: 'a', meta: { version: 1 } },
      { actorId: 'u', action: 'skill.move', target: 'a', meta: { from: 'devops', to: 'general' } },
    ]);
  });

  it('restores in place into its own, restored folder without a move', async () => {
    await restoreFolder(deps, { slug: 'devops', actorId: 'u' });
    audit.length = 0;
    const r = await restoreSkill(deps, { slug: 'a', actorId: 'u', folder: 'devops' });
    expect(r.ok).toBe(true);
    expect(actions()).toEqual(['skill.restore']);
  });

  it('checks the target folder', async () => {
    const run = (folder: string) => restoreSkill(deps, { slug: 'a', actorId: 'u', folder });
    expect(code(await run('nope'))).toBe('folder_not_found');
    expect(code(await run('BAD'))).toBe('invalid_slug');
    expect(code(await run('devops'))).toBe('folder_archived');
    expect(code(await restoreSkill(deps, { slug: 'zz', actorId: 'u' }))).toBe('skill_not_found');
    expect(audit).toEqual([]);
  });
});
