import { beforeEach, describe, expect, it } from 'vite-plus/test';
import { type Audited, makeCatalogDeps } from '../../../../test/fakes/catalog-deps.ts';
import type { InMemorySubagentRepository } from '../../../../test/fakes/in-memory-subagent-repository.ts';
import type { CatalogError } from '../domain/errors.ts';
import { archiveSkill } from './commands/archive.ts';
import { createSkill } from './commands/create-skill.ts';
import { archiveFolder, createFolder } from './commands/folders.ts';
import {
  archiveSubagent,
  createSubagent,
  moveSubagent,
  publishSubagent,
  restoreSubagent,
  rollbackSubagent,
} from './commands/subagents.ts';
import type { CatalogDeps } from './deps.ts';
import { getSkill } from './queries/get-skill.ts';
import {
  diffSubagentVersions,
  getSubagent,
  getSubagentHistory,
  listSubagents,
} from './queries/subagents.ts';

let deps: CatalogDeps;
let subagents: InMemorySubagentRepository;
let audit: Audited[];

beforeEach(() => {
  ({ deps, subagents, audit } = makeCatalogDeps());
});

const content = (
  name: string,
  extra: { tools?: string[]; skills?: string[]; body?: string } = {},
) =>
  [
    '---',
    `name: ${name}`,
    'description: does things',
    ...(extra.tools ? [`tools: [${extra.tools.join(', ')}]`] : []),
    ...(extra.skills ? [`skills: [${extra.skills.join(', ')}]`] : []),
    '---',
    extra.body ?? 'body',
    '',
  ].join('\n');

const code = (r: { ok: boolean; error?: CatalogError } | { ok: true; value: unknown }) =>
  !r.ok && 'error' in r ? r.error?.code : 'ok';
const mkSkill = (slug: string) =>
  createSkill(deps, {
    slug,
    folder: 'general',
    files: [
      {
        path: 'SKILL.md',
        bytes: new TextEncoder().encode(`---\nname: ${slug}\ndescription: d\n---\nb\n`),
      },
    ],
    actorId: 'u',
    message: null,
    source: null,
    sourceCommit: null,
  });
const create = (slug: string, text = content(slug), folder = 'general') =>
  createSubagent(deps, { slug, folder, content: text, actorId: 'u', message: null });
const publish = (slug: string, baseVersion: number, text: string) =>
  publishSubagent(deps, { slug, baseVersion, content: text, actorId: 'u', message: 'm' });
const must = <T>(r: { ok: true; value: T } | { ok: false; error: CatalogError }): T => {
  if (!r.ok) throw r.error;
  return r.value;
};

describe('createSubagent', () => {
  it('creates version 1 and audits it', async () => {
    audit.length = 0;
    expect(await create('rev')).toEqual({ ok: true, value: { slug: 'rev', version: 1 } });
    expect(audit).toEqual([
      {
        actorId: 'u',
        action: 'subagent.create',
        target: 'rev',
        meta: { version: 1, folder: 'general' },
      },
    ]);
    expect(subagents.outbox.map((e) => e.type)).toEqual(['catalog.subagent_version_created']);
    const v = must(await getSubagent(deps, { slug: 'rev' }));
    expect(v).toMatchObject({ version: 1, model: 'inherit', tools: null, skills: [] });
    expect(v.content).toBe(content('rev'));
  });

  it('rejects an unknown skill and an archived skill, naming the first offender', async () => {
    await mkSkill('good');
    await mkSkill('old');
    await archiveSkill(deps, { slug: 'old', actorId: 'u' });
    const unknown = await create('a', content('a', { skills: ['good', 'ghost', 'old'] }));
    expect(code(unknown)).toBe('unknown_skill');
    expect(!unknown.ok && unknown.error.message).toBe('skill "ghost" is not an active skill');
    const archived = await create('a', content('a', { skills: ['good', 'old'] }));
    expect(!archived.ok && archived.error.message).toBe('skill "old" is not an active skill');
    expect(await listSubagents(deps, { status: 'all' })).toEqual([]);
  });

  it('requires an active folder and a free, non-reserved slug', async () => {
    expect(code(await create('a', content('a'), 'nope'))).toBe('folder_not_found');
    await createFolder(deps, { slug: 'old', name: 'Old', description: 'x', actorId: 'u' });
    await archiveFolder(deps, { slug: 'old', actorId: 'u' });
    expect(code(await create('a', content('a'), 'old'))).toBe('folder_archived');
    expect(code(await create('a'))).toBe('ok');
    expect(code(await create('a'))).toBe('subagent_exists');
    expect(code(await create('new'))).toBe('invalid_slug');
    expect(code(await create('Bad Slug'))).toBe('invalid_slug');
  });

  it('propagates content errors', async () => {
    expect(code(await create('a', 'no frontmatter'))).toBe('invalid_frontmatter');
    expect(code(await create('a', content('b')))).toBe('name_mismatch');
  });
});

describe('publishSubagent', () => {
  it('bumps the version when the tools change and emits the event', async () => {
    await create('a');
    audit.length = 0;
    const before = subagents.outbox.length;
    const r = await publish('a', 1, content('a', { tools: ['Read', 'Grep'] }));
    expect(r).toEqual({ ok: true, value: { slug: 'a', version: 2 } });
    expect(subagents.outbox.slice(before).map((e) => [e.type, e.payload['version']])).toEqual([
      ['catalog.subagent_version_created', 2],
    ]);
    expect(audit).toEqual([
      { actorId: 'u', action: 'subagent.publish', target: 'a', meta: { version: 2 } },
    ]);
    expect(must(await getSubagent(deps, { slug: 'a' })).tools).toEqual(['Read', 'Grep']);
  });

  it('reports not found, a stale base, an archived subagent and bad skills', async () => {
    expect(code(await publish('a', 1, content('a')))).toBe('subagent_not_found');
    expect(code(await publish('Bad Slug', 1, content('a')))).toBe('invalid_slug');
    await create('a');
    expect(code(await publish('a', 5, content('a')))).toBe('version_conflict');
    expect(code(await publish('a', 1, content('a', { skills: ['ghost'] })))).toBe('unknown_skill');
    expect(code(await publish('a', 1, content('b')))).toBe('name_mismatch');
    await archiveSubagent(deps, { slug: 'a', actorId: 'u' });
    expect(code(await publish('a', 1, content('a')))).toBe('subagent_archived');
  });
});

describe('rollbackSubagent', () => {
  it('rolls back to a version listing a skill archived since', async () => {
    await mkSkill('s');
    await create('a', content('a', { skills: ['s'] }));
    await publish('a', 1, content('a'));
    await archiveSkill(deps, { slug: 's', actorId: 'u' });
    audit.length = 0;
    const r = await rollbackSubagent(deps, {
      slug: 'a',
      toVersion: 1,
      baseVersion: 2,
      actorId: 'u',
    });
    expect(r).toEqual({ ok: true, value: { slug: 'a', version: 3 } });
    expect(audit).toEqual([
      { actorId: 'u', action: 'subagent.rollback', target: 'a', meta: { version: 3 } },
    ]);
    const v = must(await getSubagent(deps, { slug: 'a' }));
    expect(v).toMatchObject({ version: 3, skills: ['s'] });
    expect(must(await getSubagentHistory(deps, { slug: 'a' }))[0]).toMatchObject({
      number: 3,
      restoredFrom: 1,
    });
  });

  it('rejects bad targets, a stale base and unknown subagents', async () => {
    await create('a');
    await publish('a', 1, content('a', { body: 'two' }));
    const go = (toVersion: number, baseVersion = 2) =>
      rollbackSubagent(deps, { slug: 'a', toVersion, baseVersion, actorId: 'u' });
    expect(code(await go(2))).toBe('version_not_found');
    expect(code(await go(0))).toBe('version_not_found');
    expect(code(await go(1.5))).toBe('version_not_found');
    expect(code(await go(1, 1))).toBe('version_conflict');
    expect(
      code(await rollbackSubagent(deps, { slug: 'x', toVersion: 1, baseVersion: 1, actorId: 'u' })),
    ).toBe('subagent_not_found');
    const missing = {
      ...deps,
      subagents: new Proxy(deps.subagents, {
        get: (t, k, r) =>
          k === 'getVersion' ? async () => null : (Reflect.get(t, k, r) as unknown),
      }),
    };
    expect(
      code(
        await rollbackSubagent(missing, { slug: 'a', toVersion: 1, baseVersion: 2, actorId: 'u' }),
      ),
    ).toBe('version_not_found');
  });
});

describe('archive, restore and move', () => {
  beforeEach(async () => {
    await create('a');
    await createFolder(deps, { slug: 'ops', name: 'Ops', description: 'x', actorId: 'u' });
    audit.length = 0;
  });

  it('archives (idempotently) and audits the version', async () => {
    expect(await archiveSubagent(deps, { slug: 'a', actorId: 'u' })).toEqual({
      ok: true,
      value: undefined,
    });
    expect(audit).toEqual([
      { actorId: 'u', action: 'subagent.archive', target: 'a', meta: { version: 1 } },
    ]);
    expect(code(await archiveSubagent(deps, { slug: 'a', actorId: 'u' }))).toBe('ok');
    expect(code(await archiveSubagent(deps, { slug: 'zz', actorId: 'u' }))).toBe(
      'subagent_not_found',
    );
  });

  it('restores even when a listed skill is archived since', async () => {
    await mkSkill('s');
    await publish('a', 1, content('a', { skills: ['s'] }));
    await archiveSubagent(deps, { slug: 'a', actorId: 'u' });
    await archiveSkill(deps, { slug: 's', actorId: 'u' });
    audit.length = 0;
    expect(code(await restoreSubagent(deps, { slug: 'a', actorId: 'u' }))).toBe('ok');
    expect(audit).toEqual([
      { actorId: 'u', action: 'subagent.restore', target: 'a', meta: { version: 2 } },
    ]);
    expect(must(await getSubagent(deps, { slug: 'a' })).status).toBe('active');
  });

  it('refuses to restore into an archived folder, restores into another with folder', async () => {
    await archiveFolder(deps, { slug: 'general', actorId: 'u' });
    audit.length = 0;
    expect(code(await restoreSubagent(deps, { slug: 'a', actorId: 'u' }))).toBe('folder_archived');
    expect(code(await restoreSubagent(deps, { slug: 'a', actorId: 'u', folder: 'general' }))).toBe(
      'folder_archived',
    );
    expect(code(await restoreSubagent(deps, { slug: 'a', actorId: 'u', folder: 'nope' }))).toBe(
      'folder_not_found',
    );
    expect(code(await restoreSubagent(deps, { slug: 'zz', actorId: 'u' }))).toBe(
      'subagent_not_found',
    );
    expect(audit).toEqual([]);
    expect(code(await restoreSubagent(deps, { slug: 'a', actorId: 'u', folder: 'ops' }))).toBe(
      'ok',
    );
    expect(audit.map((e) => [e.action, e.meta])).toEqual([
      ['subagent.restore', { version: 1 }],
      ['subagent.move', { from: 'general', to: 'ops' }],
    ]);
    expect(must(await getSubagent(deps, { slug: 'a' })).folder.slug).toBe('ops');
  });

  it('restoring into the same folder records no move', async () => {
    await archiveSubagent(deps, { slug: 'a', actorId: 'u' });
    audit.length = 0;
    await restoreSubagent(deps, { slug: 'a', actorId: 'u', folder: 'general' });
    expect(audit.map((e) => e.action)).toEqual(['subagent.restore']);
  });

  it('moves between active folders', async () => {
    expect(code(await moveSubagent(deps, { slug: 'a', folder: 'ops', actorId: 'u' }))).toBe('ok');
    expect(audit).toEqual([
      {
        actorId: 'u',
        action: 'subagent.move',
        target: 'a',
        meta: { from: 'general', to: 'ops' },
      },
    ]);
    audit.length = 0;
    expect(code(await moveSubagent(deps, { slug: 'a', folder: 'ops', actorId: 'u' }))).toBe('ok');
    expect(audit).toEqual([]);
  });

  it('refuses to move into an archived or unknown folder or an archived subagent', async () => {
    await archiveFolder(deps, { slug: 'ops', actorId: 'u' });
    expect(code(await moveSubagent(deps, { slug: 'a', folder: 'ops', actorId: 'u' }))).toBe(
      'folder_archived',
    );
    expect(code(await moveSubagent(deps, { slug: 'a', folder: 'nope', actorId: 'u' }))).toBe(
      'folder_not_found',
    );
    expect(code(await moveSubagent(deps, { slug: 'zz', folder: 'ops', actorId: 'u' }))).toBe(
      'subagent_not_found',
    );
    await archiveSubagent(deps, { slug: 'a', actorId: 'u' });
    expect(code(await moveSubagent(deps, { slug: 'a', folder: 'general', actorId: 'u' }))).toBe(
      'subagent_archived',
    );
  });
});

describe('queries', () => {
  it('getSubagent returns the fields of the requested version', async () => {
    await create('a', content('a', { tools: ['Read'], body: 'one' }));
    await publish('a', 1, content('a', { tools: ['Bash'], body: 'two' }));
    const v1 = must(await getSubagent(deps, { slug: 'a', version: 1 }));
    expect(v1).toMatchObject({ version: 1, tools: ['Read'], status: 'active' });
    expect(v1.content).toContain('one');
    const cur = must(await getSubagent(deps, { slug: 'a', version: 2 }));
    expect(cur).toMatchObject({ version: 2, tools: ['Bash'], folder: { slug: 'general' } });
    expect(code(await getSubagent(deps, { slug: 'a', version: 9 }))).toBe('version_not_found');
    expect(code(await getSubagent(deps, { slug: 'zz' }))).toBe('subagent_not_found');
  });

  it('lists by status and folder', async () => {
    await create('a');
    await create('b');
    await archiveSubagent(deps, { slug: 'b', actorId: 'u' });
    expect((await listSubagents(deps, { status: 'active' })).map((s) => s.slug)).toEqual(['a']);
    expect(
      (await listSubagents(deps, { status: 'all', folder: 'general' })).map((s) => s.slug),
    ).toEqual(['a', 'b']);
    expect(await listSubagents(deps, { status: 'all', folder: 'other' })).toEqual([]);
  });

  it('history is newest first', async () => {
    await create('a');
    await publish('a', 1, content('a', { body: 'x' }));
    expect(must(await getSubagentHistory(deps, { slug: 'a' })).map((h) => h.number)).toEqual([
      2, 1,
    ]);
    expect(code(await getSubagentHistory(deps, { slug: 'zz' }))).toBe('subagent_not_found');
  });

  it('diff returns tools from/to and a patch, null for identical versions', async () => {
    await create('a', content('a', { body: 'one' }));
    await publish('a', 1, content('a', { tools: ['Read'], body: 'two' }));
    await rollbackSubagent(deps, { slug: 'a', toVersion: 1, baseVersion: 2, actorId: 'u' });
    const d = must(await diffSubagentVersions(deps, { slug: 'a', from: 1, to: 2 }));
    expect(d.tools).toEqual({ from: null, to: ['Read'] });
    expect(d.patch).toContain('-one');
    expect(d.patch).toContain('+two');
    const same = must(await diffSubagentVersions(deps, { slug: 'a', from: 1, to: 3 }));
    expect(same).toEqual({ patch: null, tools: { from: null, to: null } });
    expect(code(await diffSubagentVersions(deps, { slug: 'a', from: 1, to: 9 }))).toBe(
      'version_not_found',
    );
    expect(code(await diffSubagentVersions(deps, { slug: 'a', from: 9, to: 1 }))).toBe(
      'version_not_found',
    );
    expect(code(await diffSubagentVersions(deps, { slug: 'zz', from: 1, to: 2 }))).toBe(
      'subagent_not_found',
    );
  });
});

describe('usedBy and archiveFolder', () => {
  it('getSkill lists the active subagents using the skill', async () => {
    await mkSkill('s');
    await create('b', content('b', { skills: ['s'] }));
    await create('a', content('a', { skills: ['s'] }));
    await create('c');
    await create('d', content('d', { skills: ['s'] }));
    await archiveSubagent(deps, { slug: 'd', actorId: 'u' });
    expect(must(await getSkill(deps, { slug: 's' })).usedBy).toEqual(['a', 'b']);
  });

  it('archives the folder with its skills and subagents and records both counts', async () => {
    await createFolder(deps, { slug: 'ops', name: 'Ops', description: 'x', actorId: 'u' });
    await mkSkill('other');
    await createSkill(deps, {
      slug: 'sk',
      folder: 'ops',
      files: [
        {
          path: 'SKILL.md',
          bytes: new TextEncoder().encode('---\nname: sk\ndescription: d\n---\n'),
        },
      ],
      actorId: 'u',
      message: null,
      source: null,
      sourceCommit: null,
    });
    await create('x', content('x'), 'ops');
    await create('y', content('y'), 'ops');
    await create('stay');
    audit.length = 0;
    const r = await archiveFolder(deps, { slug: 'ops', actorId: 'u' });
    expect(r).toEqual({ ok: true, value: { archivedSkills: 1, archivedSubagents: 2 } });
    expect(audit).toEqual([
      {
        actorId: 'u',
        action: 'folder.archive',
        target: 'ops',
        meta: { archivedSkills: 1, archivedSubagents: 2 },
      },
      {
        actorId: 'u',
        action: 'skill.archive',
        target: 'sk',
        meta: { version: 1, viaFolder: 'ops' },
      },
      {
        actorId: 'u',
        action: 'subagent.archive',
        target: 'x',
        meta: { version: 1, viaFolder: 'ops' },
      },
      {
        actorId: 'u',
        action: 'subagent.archive',
        target: 'y',
        meta: { version: 1, viaFolder: 'ops' },
      },
    ]);
    expect((await listSubagents(deps, { status: 'active' })).map((s) => s.slug)).toEqual(['stay']);
    expect(
      subagents.outbox
        .filter((e) => e.type === 'catalog.subagent_archived')
        .map((e) => e.payload['slug']),
    ).toEqual(['x', 'y']);
  });
});
