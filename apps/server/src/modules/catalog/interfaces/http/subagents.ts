import {
  CreateSubagentRequest,
  DiffQuery,
  ListSubagentsQuery,
  MoveSkillRequest,
  PublishSubagentRequest,
  RestoreSkillRequest,
  RollbackRequest,
  VersionQuery,
} from '@skills/contracts';
import { Hono } from 'hono';
import type { AppEnv } from '../../../../platform/http/env.ts';
import { unwrap } from '../../../../platform/http/errors.ts';
import { readJson, readQuery } from '../../../../platform/http/request.ts';
import { limitBody } from '../../../../platform/http/security.ts';
import {
  archiveSubagent,
  createSubagent,
  moveSubagent,
  publishSubagent,
  restoreSubagent,
  rollbackSubagent,
} from '../../application/commands/subagents.ts';
import type { CatalogDeps } from '../../application/deps.ts';
import {
  diffSubagentVersions,
  getSubagent,
  getSubagentHistory,
  listSubagents,
} from '../../application/queries/subagents.ts';
import type { LoginsByIds, SearchSlugs } from './skills.ts';

const JSON_BODY_LIMIT = 256 * 1024;

/** `/api/subagents`. */
export function subagentRoutes(deps: CatalogDeps, search: SearchSlugs, logins: LoginsByIds) {
  return new Hono<AppEnv>()
    .get('/', async (c) => {
      const { status, q, folder } = readQuery(c, ListSubagentsQuery);
      const all = await listSubagents(deps, {
        status,
        ...(folder === undefined ? {} : { folder }),
      });
      const query = q?.trim() ?? '';
      if (query === '') return c.json(all);
      const bySlug = new Map(all.map((s) => [s.slug, s]));
      const hits = await search(query, folder === undefined ? undefined : [folder]);
      return c.json(hits.flatMap((slug) => bySlug.get(slug) ?? []));
    })
    .post('/', limitBody(JSON_BODY_LIMIT), async (c) => {
      const body = await readJson(c, CreateSubagentRequest);
      const r = await createSubagent(deps, {
        slug: body.slug,
        folder: body.folder,
        content: body.content,
        message: body.message || null,
        actorId: c.get('principal').userId,
      });
      return c.json(unwrap(r), 201);
    })
    .get('/:slug', async (c) => {
      const { version } = readQuery(c, VersionQuery);
      const r = await getSubagent(deps, {
        slug: c.req.param('slug'),
        ...(version === undefined ? {} : { version }),
      });
      return c.json(unwrap(r));
    })
    .put('/:slug', limitBody(JSON_BODY_LIMIT), async (c) => {
      const body = await readJson(c, PublishSubagentRequest);
      const r = await publishSubagent(deps, {
        slug: c.req.param('slug'),
        baseVersion: body.baseVersion,
        content: body.content,
        message: body.message || null,
        actorId: c.get('principal').userId,
      });
      return c.json(unwrap(r));
    })
    .get('/:slug/history', async (c) => {
      const versions = unwrap(await getSubagentHistory(deps, { slug: c.req.param('slug') }));
      const byId = await logins(versions.map((v) => v.authorId));
      return c.json(
        versions.map((v) => Object.assign(v, { authorLogin: byId.get(v.authorId) ?? null })),
      );
    })
    .get('/:slug/diff', async (c) => {
      const { from, to } = readQuery(c, DiffQuery);
      return c.json(
        unwrap(await diffSubagentVersions(deps, { slug: c.req.param('slug'), from, to })),
      );
    })
    .post('/:slug/rollback', async (c) => {
      const body = await readJson(c, RollbackRequest);
      const r = await rollbackSubagent(deps, {
        slug: c.req.param('slug'),
        ...body,
        actorId: c.get('principal').userId,
      });
      return c.json(unwrap(r));
    })
    .post('/:slug/archive', async (c) => {
      unwrap(
        await archiveSubagent(deps, {
          slug: c.req.param('slug'),
          actorId: c.get('principal').userId,
        }),
      );
      return c.body(null, 204);
    })
    .post('/:slug/move', async (c) => {
      const { folder } = await readJson(c, MoveSkillRequest);
      unwrap(
        await moveSubagent(deps, {
          slug: c.req.param('slug'),
          folder,
          actorId: c.get('principal').userId,
        }),
      );
      return c.body(null, 204);
    })
    .post('/:slug/restore', async (c) => {
      const { folder } = await readJson(c, RestoreSkillRequest);
      unwrap(
        await restoreSubagent(deps, {
          slug: c.req.param('slug'),
          ...(folder === undefined ? {} : { folder }),
          actorId: c.get('principal').userId,
        }),
      );
      return c.body(null, 204);
    });
}
