import { LoginRequest } from '@skills/contracts';
import { Hono } from 'hono';
import type { AppEnv } from '../../../../platform/http/env.ts';
import { domainErrorResponse } from '../../../../platform/http/errors.ts';
import { readJson } from '../../../../platform/http/request.ts';
import type { IdentityDeps } from '../../application/ports.ts';
import { login, logout } from '../../application/sessions.ts';
import { IdentityError } from '../../domain/user.ts';
import { clearSessionCookie, sessionIdOf, setSessionCookie } from './session.ts';

/** `/api/auth`. Login is the only /api route reachable without a session. */
export function authRoutes(deps: IdentityDeps, opts: { cookieSecure: boolean }) {
  return new Hono<AppEnv>()
    .post('/login', async (c) => {
      const body = await readJson(c, LoginRequest);
      const r = await login(deps, { ...body, ip: c.get('clientIp') });
      if (!r.ok) {
        // A disabled account answers like a wrong password: it must not confirm the password.
        const e =
          r.error.code === 'disabled'
            ? new IdentityError('invalid_credentials', 'invalid login or password')
            : r.error;
        return domainErrorResponse(c, e);
      }
      setSessionCookie(c, r.value.sessionId, opts.cookieSecure);
      return c.body(null, 204);
    })
    .post('/logout', async (c) => {
      const sessionId = sessionIdOf(c);
      if (sessionId) await logout(deps, { sessionId });
      clearSessionCookie(c, opts.cookieSecure);
      return c.body(null, 204);
    })
    .get('/me', (c) => {
      const p = c.get('principal');
      return c.json({ login: p.login, role: p.role });
    });
}
