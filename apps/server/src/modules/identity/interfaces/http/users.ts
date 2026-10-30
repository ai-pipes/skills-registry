import { CreateUserRequest, ResetPasswordRequest, SetDisabledRequest } from '@skills/contracts';
import { Hono } from 'hono';
import type { AppEnv } from '../../../../platform/http/env.ts';
import { errorResponse, unwrap } from '../../../../platform/http/errors.ts';
import { readJson } from '../../../../platform/http/request.ts';
import type { IdentityDeps } from '../../application/ports.ts';
import { createUser, listUsers, resetPassword, setDisabled } from '../../application/users.ts';
import { parseId } from './tokens.ts';

/** `/api/users`: admin only. The use cases enforce it too; the route check runs before parsing. */
export function userRoutes(deps: IdentityDeps) {
  return new Hono<AppEnv>()
    .use((c, next) =>
      c.get('principal').role === 'admin'
        ? next()
        : Promise.resolve(errorResponse(c, 'forbidden', 'admin only')),
    )
    .get('/', async (c) => c.json(unwrap(await listUsers(deps, { principal: c.get('principal') }))))
    .post('/', async (c) => {
      const body = await readJson(c, CreateUserRequest);
      const r = unwrap(await createUser(deps, { principal: c.get('principal'), ...body }));
      return c.json({ id: r.id }, 201);
    })
    .post('/:id/password', async (c) => {
      const userId = parseId(c.req.param('id'), 'user');
      const { password } = await readJson(c, ResetPasswordRequest);
      unwrap(await resetPassword(deps, { principal: c.get('principal'), userId, password }));
      return c.body(null, 204);
    })
    .post('/:id/disable', async (c) => {
      const userId = parseId(c.req.param('id'), 'user');
      const { disabled } = await readJson(c, SetDisabledRequest);
      unwrap(await setDisabled(deps, { principal: c.get('principal'), userId, disabled }));
      return c.body(null, 204);
    });
}
