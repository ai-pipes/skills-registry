import {
  type AuthConfigResponse,
  LoginRequest,
  SsoCallbackQuery,
  SsoLoginQuery,
  type SsoLoginError,
} from '@skills/contracts';
import { Hono } from 'hono';
import type { AppEnv } from '../../../../platform/http/env.ts';
import { domainErrorResponse, errorResponse } from '../../../../platform/http/errors.ts';
import { readJson } from '../../../../platform/http/request.ts';
import { completeSsoLogin, startSsoLogin } from '../../application/oidc-login.ts';
import type { IdentityDeps } from '../../application/ports.ts';
import { login, logout } from '../../application/sessions.ts';
import { IdentityError } from '../../domain/user.ts';
import {
  clearLoginBindingCookie,
  clearSessionCookie,
  loginBindingOf,
  sessionIdOf,
  setLoginBindingCookie,
  setSessionCookie,
} from './session.ts';

export type AuthRouteOptions = {
  cookieSecure: boolean;
  /**
   * The SSO routes answer every outcome with a redirect to the login page, so an unexpected
   * error is logged here (without its message) and the page gets the fixed code `internal`.
   */
  logError: (error: unknown, message: string) => void;
};

/** Routes reachable without a session (or token); everything else under /api needs one. */
export const PUBLIC_AUTH_PATHS: ReadonlySet<string> = new Set([
  '/api/auth/login',
  '/api/auth/logout',
  '/api/auth/config',
  '/api/auth/sso/login',
  '/api/auth/sso/callback',
]);

const SSO_ERRORS = new Set<string>([
  'invalid_state',
  'not_allowed',
  'disabled',
  'idp_unavailable',
] satisfies SsoLoginError[]);

/** Where the browser goes after a failed single sign-on. */
const loginErrorUrl = (code: string): string =>
  `/login?loginError=${SSO_ERRORS.has(code) ? code : ('internal' satisfies SsoLoginError)}`;

/** `/api/auth`: password login, single sign-on, logout and the current user. */
export function authRoutes(deps: IdentityDeps, opts: AuthRouteOptions) {
  const ssoRoutes = new Hono<AppEnv>()
    .use((c, next) =>
      deps.sso
        ? next()
        : Promise.resolve(errorResponse(c, 'not_found', 'single sign-on is not configured')),
    )
    .get('/login', async (c) => {
      const query = SsoLoginQuery.safeParse(c.req.query());
      const returnTo = query.success ? query.data.returnTo : '/';
      let started;
      try {
        started = await startSsoLogin(deps, { returnTo });
      } catch (error) {
        opts.logError(error, 'auth: sso login start failed');
        return c.redirect(loginErrorUrl('internal'), 302);
      }
      // The provider is unreachable: back to the login page with a fixed code.
      if (!started.ok) return c.redirect(loginErrorUrl(started.error.code), 302);
      setLoginBindingCookie(c, started.value.state, opts.cookieSecure);
      return c.redirect(started.value.url.toString(), 302);
    })
    .get('/callback', async (c) => {
      // A cancelled or broken provider answer carries no usable code/state.
      const parsed = SsoCallbackQuery.safeParse(c.req.query());
      const bound = loginBindingOf(c);
      clearLoginBindingCookie(c, opts.cookieSecure);
      if (!parsed.success || bound !== parsed.data.state) {
        return c.redirect(loginErrorUrl('invalid_state'), 302);
      }
      let r;
      try {
        r = await completeSsoLogin(deps, {
          state: parsed.data.state,
          code: parsed.data.code,
          ip: c.get('clientIp'),
          ...(parsed.data.iss === undefined ? {} : { iss: parsed.data.iss }),
        });
      } catch (error) {
        // The browser came back from the provider: a page with a fixed code, not a JSON 500.
        opts.logError(error, 'auth: sso callback failed');
        return c.redirect(loginErrorUrl('internal'), 302);
      }
      if (!r.ok) return c.redirect(loginErrorUrl(r.error.code), 302);
      setSessionCookie(c, r.value.sessionId, opts.cookieSecure);
      return c.redirect(r.value.returnTo, 302);
    });

  return new Hono<AppEnv>()
    .get('/config', (c) => {
      const body: AuthConfigResponse = { method: deps.sso ? 'sso' : 'password' };
      return c.json(body);
    })
    .route('/sso', ssoRoutes)
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
