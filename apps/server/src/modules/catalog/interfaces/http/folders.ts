import { CreateFolderRequest, ListFoldersQuery, UpdateFolderRequest } from '@skills/contracts';
import { Hono } from 'hono';
import type { AppEnv } from '../../../../platform/http/env.ts';
import { unwrap } from '../../../../platform/http/errors.ts';
import { readJson, readQuery } from '../../../../platform/http/request.ts';
import {
  archiveFolder,
  createFolder,
  restoreFolder,
  updateFolder,
} from '../../application/commands/folders.ts';
import type { CatalogDeps } from '../../application/deps.ts';
import { listFolders } from '../../application/queries/list-folders.ts';

/** `/api/folders`. */
export function folderRoutes(deps: CatalogDeps) {
  return new Hono<AppEnv>()
    .get('/', async (c) => {
      const { status } = readQuery(c, ListFoldersQuery);
      return c.json(await listFolders(deps, { status }));
    })
    .post('/', async (c) => {
      const body = await readJson(c, CreateFolderRequest);
      const r = await createFolder(deps, { ...body, actorId: c.get('principal').userId });
      return c.json(unwrap(r), 201);
    })
    .put('/:slug', async (c) => {
      const { name, description } = await readJson(c, UpdateFolderRequest);
      const r = await updateFolder(deps, {
        slug: c.req.param('slug'),
        name,
        description,
        actorId: c.get('principal').userId,
      });
      return c.json(unwrap(r));
    })
    .post('/:slug/archive', async (c) => {
      const r = await archiveFolder(deps, {
        slug: c.req.param('slug'),
        actorId: c.get('principal').userId,
      });
      return c.json(unwrap(r));
    })
    .post('/:slug/restore', async (c) => {
      unwrap(
        await restoreFolder(deps, {
          slug: c.req.param('slug'),
          actorId: c.get('principal').userId,
        }),
      );
      return c.body(null, 204);
    });
}
