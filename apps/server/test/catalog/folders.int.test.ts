import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vite-plus/test';
import {
  archiveFolder,
  archiveSkill,
  type CatalogDeps,
  createFolder,
  createPgCatalog,
  createSkill,
  getSkill,
  listFolders,
  moveSkill,
  restoreSkill,
} from '../../src/modules/catalog/index.ts';
import type { Audited } from '../fakes/catalog-deps.ts';
import { FixedClock } from '../fakes/fixed-clock.ts';
import { shaHasher } from '../fakes/sha-hasher.ts';
import { startPg, truncateAll } from '../pg.ts';

let pg: Awaited<ReturnType<typeof startPg>>;
let deps: CatalogDeps;
let audit: Audited[];

beforeAll(async () => {
  pg = await startPg();
});
afterAll(async () => {
  await pg.stop();
});
beforeEach(async () => {
  await truncateAll(pg.sql);
  audit = [];
  deps = {
    ...createPgCatalog(pg.sql),
    hasher: shaHasher,
    ids: { uuid: () => randomUUID() },
    clock: new FixedClock(),
    audit: {
      record: async (e) => {
        audit.push(e);
      },
    },
  };
});

const enc = (s: string) => new TextEncoder().encode(s);
const ACTOR = randomUUID();
const create = (slug: string, folder: string) =>
  createSkill(deps, {
    slug,
    folder,
    files: [{ path: 'SKILL.md', bytes: enc(`---\nname: ${slug}\ndescription: d\n---\nbody\n`) }],
    actorId: ACTOR,
    message: null,
    source: null,
    sourceCommit: null,
  });
const folder = async (slug: string) => {
  const r = await createFolder(deps, { slug, name: slug, description: 'd', actorId: ACTOR });
  if (!r.ok) throw r.error;
};
const archivedEvents = async () =>
  (await pg.sql`select 1 from platform.outbox where type = 'catalog.skill_archived'`).length;
const activeInArchived = async () => {
  const [row] = await pg.sql<{ n: number }[]>`
    select count(*)::int as n from catalog.skills s
    join catalog.folders f on f.id = s.folder_id
    where f.status = 'archived' and s.status = 'active'`;
  return row!.n;
};
const statusOf = async (slug: string) => {
  const v = await getSkill(deps, { slug });
  if (!v.ok) throw v.error;
  return v.value.status;
};

/** Runs `round` 20 times one after another, each with its own folder `race-<i>`. */
const rounds = (round: (i: number) => Promise<void>) =>
  Array.from({ length: 20 }, (_, i) => i).reduce(async (prev, i) => {
    await prev;
    await round(i);
  }, Promise.resolve());

describe('folder use cases on Postgres', () => {
  it('cascades an archive to every active skill of the folder in one transaction', async () => {
    await folder('devops');
    await Promise.all(
      ['a', 'b', 'c', 'd', 'other'].map((s) => create(s, s === 'other' ? 'general' : 'devops')),
    );
    await archiveSkill(deps, { slug: 'd', actorId: ACTOR });
    const before = await archivedEvents();

    const r = await archiveFolder(deps, { slug: 'devops', actorId: ACTOR });
    expect(r).toEqual({ ok: true, value: { archivedSkills: 3 } });
    expect((await archivedEvents()) - before).toBe(3);
    expect(await Promise.all(['a', 'b', 'c', 'd', 'other'].map(statusOf))).toEqual([
      'archived',
      'archived',
      'archived',
      'archived',
      'active',
    ]);
    const devops = (await listFolders(deps, { status: 'archived' })).find(
      (f) => f.slug === 'devops',
    );
    expect(devops?.skills).toEqual({ active: 0, archived: 4 });
    expect(await activeInArchived()).toBe(0);
    expect(audit.filter((e) => e.action === 'skill.archive').map((e) => e.meta)).toContainEqual({
      version: 1,
      viaFolder: 'devops',
    });
  });

  it('restores a skill into another folder in one save', async () => {
    await folder('devops');
    await create('a', 'devops');
    await archiveFolder(deps, { slug: 'devops', actorId: ACTOR });
    const refused = await restoreSkill(deps, { slug: 'a', actorId: ACTOR });
    expect(!refused.ok && refused.error.code).toBe('folder_archived');
    expect(await restoreSkill(deps, { slug: 'a', actorId: ACTOR, folder: 'general' })).toEqual({
      ok: true,
      value: undefined,
    });
    const view = await getSkill(deps, { slug: 'a' });
    expect(view.ok && [view.value.status, view.value.folder.slug]).toEqual(['active', 'general']);
  });

  it('never leaves a created skill active in an archived folder (race)', async () => {
    await rounds(async (i) => {
      await folder(`race-${i}`);
      const [archived, created] = await Promise.allSettled([
        archiveFolder(deps, { slug: `race-${i}`, actorId: ACTOR }),
        create(`s-${i}`, `race-${i}`),
      ]);
      expect(archived).toMatchObject({ status: 'fulfilled', value: { ok: true } });
      if (created.status !== 'fulfilled') throw created.reason;
      if (created.value.ok) {
        expect(await statusOf(`s-${i}`)).toBe('archived');
      } else {
        expect(created.value.error.code).toBe('folder_archived');
      }
      expect(await activeInArchived()).toBe(0);
    });
  });

  it('never leaves a moved skill active in an archived folder (race)', async () => {
    await rounds(async (i) => {
      await folder(`race-${i}`);
      await create(`s-${i}`, 'general');
      const [archived, moved] = await Promise.allSettled([
        archiveFolder(deps, { slug: `race-${i}`, actorId: ACTOR }),
        moveSkill(deps, { slug: `s-${i}`, folder: `race-${i}`, actorId: ACTOR }),
      ]);
      expect(archived).toMatchObject({ status: 'fulfilled', value: { ok: true } });
      if (moved.status !== 'fulfilled') throw moved.reason;
      const view = await getSkill(deps, { slug: `s-${i}` });
      if (!view.ok) throw view.error;
      if (moved.value.ok) {
        expect([view.value.status, view.value.folder.slug]).toEqual(['archived', `race-${i}`]);
      } else {
        expect(moved.value.error.code).toBe('folder_archived');
        expect([view.value.status, view.value.folder.slug]).toEqual(['active', 'general']);
      }
      expect(await activeInArchived()).toBe(0);
    });
  });
});
