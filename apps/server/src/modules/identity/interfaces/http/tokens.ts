import { CreateTokenRequest } from '@skills/contracts';
import { Hono } from 'hono';
import { z } from 'zod';
import type { AppEnv } from '../../../../platform/http/env.ts';
import { unwrap } from '../../../../platform/http/errors.ts';
import { readJson } from '../../../../platform/http/request.ts';
import type { IdentityDeps } from '../../application/ports.ts';
import { createToken, listTokens, revokeToken } from '../../application/tokens.ts';
import { IdentityError } from '../../domain/user.ts';

const Uuid = z.uuid();

/** Ids that are not UUIDs cannot exist; answering 404 keeps them away from Postgres. */
export function parseId(raw: string, what: string): string {
  if (!Uuid.safeParse(raw).success) throw new IdentityError('not_found', `${what} not found`);
  return raw;
}

/** The `claude mcp add` command that connects Claude Code to this server with `token`. */
export function connectCommand(publicUrl: string, token: string): string {
  const mcpUrl = `${publicUrl.replace(/\/+$/, '')}/mcp`;
  return `claude mcp add --transport http skills ${mcpUrl} --header "Authorization: Bearer ${token}"`;
}

/** `/api/tokens`: the caller's own API tokens. */
export function tokenRoutes(deps: IdentityDeps, opts: { publicUrl: string }) {
  return new Hono<AppEnv>()
    .get('/', async (c) => c.json(await listTokens(deps, { principal: c.get('principal') })))
    .post('/', async (c) => {
      const { name } = await readJson(c, CreateTokenRequest);
      const t = await createToken(deps, { principal: c.get('principal'), name });
      return c.json(
        {
          id: t.id,
          prefix: t.prefix,
          token: t.token,
          connectCommand: connectCommand(opts.publicUrl, t.token),
        },
        201,
      );
    })
    .delete('/:id', async (c) => {
      const id = parseId(c.req.param('id'), 'token');
      unwrap(await revokeToken(deps, { principal: c.get('principal'), id }));
      return c.body(null, 204);
    });
}
