import type { Context, MiddlewareHandler } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import type { AppEnv } from '../../../../platform/http/env.ts';
import { domainErrorResponse, errorResponse } from '../../../../platform/http/errors.ts';
import { authenticateSession } from '../../application/sessions.ts';
import { authenticateToken } from '../../application/tokens.ts';
import type { IdentityDeps } from '../../application/ports.ts';

const SESSION_COOKIE = 'sr_session';
const MAX_SESSION_ID_LENGTH = 64;

const cookieOptions = (secure: boolean) =>
  ({ httpOnly: true, sameSite: 'Strict', path: '/', secure }) as const;

export function setSessionCookie(c: Context, sessionId: string, secure: boolean): void {
  setCookie(c, SESSION_COOKIE, sessionId, cookieOptions(secure));
}

export function clearSessionCookie(c: Context, secure: boolean): void {
  deleteCookie(c, SESSION_COOKIE, cookieOptions(secure));
}

export function sessionIdOf(c: Context): string | null {
  const id = getCookie(c, SESSION_COOKIE);
  return id && id.length <= MAX_SESSION_ID_LENGTH ? id : null;
}

/** True when the request carries the session cookie, whatever its value. */
export function hasSessionCookie(c: Context): boolean {
  return getCookie(c, SESSION_COOKIE) !== undefined;
}

/** Same format as on `/mcp`. */
const BEARER = /^Bearer[ \t]+(\S+)$/i;
/** Token management and user administration stay session-only (ADR 0008). */
const SESSION_ONLY = /^\/api\/(?:tokens|users)(?:\/|$)/;

/**
 * Puts the Principal into the context from either the session cookie or an
 * `Authorization: Bearer` token (ADR 0008), or answers 401. Both at once is a 400: there must
 * be no doubt whose request it is. A token is checked as on `/mcp` and cannot reach
 * `/api/tokens` or `/api/users`.
 */
export function requireSessionOrToken(deps: IdentityDeps): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const authorization = c.req.header('authorization');
    if (authorization === undefined) {
      const sessionId = sessionIdOf(c);
      const principal = sessionId ? await authenticateSession(deps, { sessionId }) : null;
      if (!principal) return errorResponse(c, 'unauthenticated', 'sign in required');
      c.set('principal', principal);
      c.set('authVia', 'session');
      return next();
    }
    if (hasSessionCookie(c)) {
      // invalid_* codes map to 422; ambiguous credentials are a plain bad request.
      const message = 'use either a session cookie or a bearer token';
      return c.json({ error: { code: 'invalid_request', message } }, 400);
    }
    const token = BEARER.exec(authorization)?.[1];
    if (!token) {
      c.header('WWW-Authenticate', 'Bearer');
      return errorResponse(c, 'unauthenticated', 'bearer token required');
    }
    const auth = await authenticateToken(deps, { token, ip: c.get('clientIp') });
    if (!auth.ok) {
      if (auth.error.code !== 'rate_limited') c.header('WWW-Authenticate', 'Bearer');
      return domainErrorResponse(c, auth.error);
    }
    if (SESSION_ONLY.test(c.req.path)) {
      return errorResponse(c, 'forbidden', 'not available with a bearer token');
    }
    c.set('principal', auth.value);
    c.set('authVia', 'token');
    return next();
  };
}
