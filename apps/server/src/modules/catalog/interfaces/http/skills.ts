import {
  CreateSkillFields,
  DiffQuery,
  ListSkillsQuery,
  MoveSkillRequest,
  PublishVersionFields,
  RestoreSkillRequest,
  RollbackRequest,
  VersionQuery,
} from '@skills/contracts';
import { Hono } from 'hono';
import type { AppEnv } from '../../../../platform/http/env.ts';
import { unwrap } from '../../../../platform/http/errors.ts';
import { readJson, readQuery } from '../../../../platform/http/request.ts';
import { limitBody } from '../../../../platform/http/security.ts';
import { archiveSkill, restoreSkill } from '../../application/commands/archive.ts';
import { createSkill } from '../../application/commands/create-skill.ts';
import { moveSkill } from '../../application/commands/move-skill.ts';
import { publishVersion } from '../../application/commands/publish-version.ts';
import { rollbackSkill } from '../../application/commands/rollback.ts';
import type { CatalogDeps } from '../../application/deps.ts';
import { diffVersions } from '../../application/queries/diff.ts';
import { getSkillFile } from '../../application/queries/get-file.ts';
import { getSkill } from '../../application/queries/get-skill.ts';
import { getHistory } from '../../application/queries/history.ts';
import { listSkills } from '../../application/queries/list-skills.ts';
import { parseKeep, readSkillUpload, UPLOAD_BODY_LIMITS } from './uploads.ts';

/** Search returns slugs best-first; injected so Catalog does not depend on Search. */
export type SearchSlugs = (query: string, folders?: string[]) => Promise<string[]>;

/** User id → login (Identity); injected so Catalog does not depend on Identity. */
export type LoginsByIds = (ids: string[]) => Promise<Map<string, string>>;

// Only types a browser will not execute; everything else text is plain text, binaries download.
const TEXT_TYPES: Record<string, string> = {
  md: 'text/markdown; charset=utf-8',
  json: 'application/json; charset=utf-8',
};

function fileHeaders(path: string, binary: boolean): Record<string, string> {
  const name = path.split('/').at(-1) ?? path;
  if (binary) {
    return {
      'Content-Type': 'application/octet-stream',
      'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(name)}`,
    };
  }
  const ext = name.includes('.') ? (name.split('.').at(-1) ?? '').toLowerCase() : '';
  return { 'Content-Type': TEXT_TYPES[ext] ?? 'text/plain; charset=utf-8' };
}

/** `/api/skills`. */
export function skillRoutes(deps: CatalogDeps, search: SearchSlugs, logins: LoginsByIds) {
  return new Hono<AppEnv>()
    .get('/', async (c) => {
      const { status, q, folder } = readQuery(c, ListSkillsQuery);
      const all = await listSkills(deps, { status, ...(folder === undefined ? {} : { folder }) });
      const query = q?.trim() ?? '';
      if (query === '') return c.json(all);
      const bySlug = new Map(all.map((s) => [s.slug, s]));
      const hits = await search(query, folder === undefined ? undefined : [folder]);
      return c.json(hits.flatMap((slug) => bySlug.get(slug) ?? []));
    })
    .post('/', limitBody(UPLOAD_BODY_LIMITS.skill), async (c) => {
      const { fields, files } = await readSkillUpload(c, CreateSkillFields);
      const r = await createSkill(deps, {
        slug: fields.slug,
        folder: fields.folder,
        files,
        actorId: c.get('principal').userId,
        message: fields.message || null,
        source:
          fields.sourceRepo === undefined
            ? null
            : {
                host: fields.sourceHost ?? '',
                repo: fields.sourceRepo,
                path: fields.sourcePath ?? '',
                ref: fields.sourceRef ?? null,
              },
        sourceCommit: fields.sourceCommit ?? null,
      });
      return c.json(unwrap(r), 201);
    })
    .get('/:slug', async (c) => {
      const { version } = readQuery(c, VersionQuery);
      const r = await getSkill(deps, {
        slug: c.req.param('slug'),
        ...(version === undefined ? {} : { version }),
      });
      return c.json(unwrap(r));
    })
    .put('/:slug', limitBody(UPLOAD_BODY_LIMITS.skill), async (c) => {
      const { fields, files } = await readSkillUpload(c, PublishVersionFields);
      const r = await publishVersion(deps, {
        slug: c.req.param('slug'),
        baseVersion: fields.baseVersion,
        files,
        keepFromBase: parseKeep(fields.keep),
        actorId: c.get('principal').userId,
        message: fields.message || null,
        sourceCommit: fields.sourceCommit ?? null,
      });
      return c.json(unwrap(r));
    })
    .get('/:slug/files/:path{.+}', async (c) => {
      const { version } = readQuery(c, VersionQuery);
      const file = unwrap(
        await getSkillFile(deps, {
          slug: c.req.param('slug'),
          path: c.req.param('path'),
          ...(version === undefined ? {} : { version }),
        }),
      );
      return c.body(new Uint8Array(file.bytes), 200, fileHeaders(file.path, file.binary));
    })
    .get('/:slug/history', async (c) => {
      const versions = unwrap(await getHistory(deps, { slug: c.req.param('slug') }));
      const byId = await logins(versions.map((v) => v.authorId));
      return c.json(
        versions.map((v) => Object.assign(v, { authorLogin: byId.get(v.authorId) ?? null })),
      );
    })
    .get('/:slug/diff', async (c) => {
      const { from, to } = readQuery(c, DiffQuery);
      return c.json(unwrap(await diffVersions(deps, { slug: c.req.param('slug'), from, to })));
    })
    .post('/:slug/rollback', async (c) => {
      const body = await readJson(c, RollbackRequest);
      const r = await rollbackSkill(deps, {
        slug: c.req.param('slug'),
        ...body,
        actorId: c.get('principal').userId,
      });
      return c.json(unwrap(r));
    })
    .post('/:slug/archive', async (c) => {
      unwrap(
        await archiveSkill(deps, { slug: c.req.param('slug'), actorId: c.get('principal').userId }),
      );
      return c.body(null, 204);
    })
    .post('/:slug/move', async (c) => {
      const { folder } = await readJson(c, MoveSkillRequest);
      unwrap(
        await moveSkill(deps, {
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
        await restoreSkill(deps, {
          slug: c.req.param('slug'),
          ...(folder === undefined ? {} : { folder }),
          actorId: c.get('principal').userId,
        }),
      );
      return c.body(null, 204);
    });
}
