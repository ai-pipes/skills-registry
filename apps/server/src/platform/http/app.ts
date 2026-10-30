import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { type Context, Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { folderRoutes } from '../../modules/catalog/interfaces/http/folders.ts';
import { skillRoutes } from '../../modules/catalog/interfaces/http/skills.ts';
import { authRoutes, PUBLIC_AUTH_PATHS } from '../../modules/identity/interfaces/http/auth.ts';
import {
  hasSessionCookie,
  requireSessionOrToken,
} from '../../modules/identity/interfaces/http/session.ts';
import { tokenRoutes } from '../../modules/identity/interfaces/http/tokens.ts';
import { userRoutes } from '../../modules/identity/interfaces/http/users.ts';
import { loginsByIds } from '../../modules/identity/index.ts';
import { searchSkills } from '../../modules/search/index.ts';
import { DomainError, errorFields } from '../../shared-kernel/index.ts';
import type { Container } from '../container.ts';
import { mcpRoute } from '../mcp/server.ts';
import type { AppEnv } from './env.ts';
import { domainErrorResponse, errorResponse } from './errors.ts';
import { spaFallback, staticFiles } from './spa.ts';
import { clientIp, csrf, defaultBodyLimit, securityHeaders, socketAddress } from './security.ts';

const DEFAULT_WEB_ROOT = fileURLToPath(new URL('../../../../web/dist', import.meta.url));
const SEARCH_LIMIT = 50;
const HEALTHZ_TIMEOUT_MS = 1500;

export type HttpAppOptions = {
  /** Peer address of the connection; defaults to the Node socket. Tests inject one. */
  remoteAddress?: (c: Context) => string;
  /** Built UI; defaults to apps/web/dist. Not served when the directory is missing. */
  webRoot?: string;
};

/** Routes that apply their own, larger body cap (after the session check). */
const isUpload = (method: string, path: string): boolean =>
  (method === 'POST' && path === '/api/skills') ||
  (method === 'PUT' && /^\/api\/skills\/[^/]+$/.test(path));

export type HttpApp = {
  app: Hono<AppEnv>;
  /** Releases what the routes hold (the MCP handler). Call after the server stops accepting. */
  close: () => Promise<void>;
};

export function createHttpApp(c: Container, opts: HttpAppOptions = {}): HttpApp {
  const app = new Hono<AppEnv>();
  const { logger, config } = c;

  // 1. request id + access log (method, path, status, duration; never headers or bodies)
  app.use(async (ctx, next) => {
    const requestId = randomUUID();
    const started = performance.now();
    ctx.set('requestId', requestId);
    ctx.header('X-Request-Id', requestId);
    await next();
    logger.info(
      {
        reqId: requestId,
        method: ctx.req.method,
        path: ctx.req.path,
        status: ctx.res.status,
        ms: Math.round(performance.now() - started),
        ip: ctx.get('clientIp'),
      },
      'request',
    );
  });
  // 2. security headers  3. body limits  4. client IP  5. CSRF on mutating /api requests
  app.use(securityHeaders());
  app.use(defaultBodyLimit(isUpload));
  app.use(
    clientIp({
      trustProxy: config.trustProxy,
      trustProxyHops: config.trustProxyHops,
      remoteAddress: opts.remoteAddress ?? socketAddress,
    }),
  );
  app.use(
    csrf(config.publicUrl, {
      // Authorization without the session cookie: the session middleware accepts only a token.
      isTokenRequest: (ctx) =>
        ctx.req.header('authorization') !== undefined && !hasSessionCookie(ctx),
    }),
  );

  app.onError((error, ctx) => {
    if (error instanceof DomainError) return domainErrorResponse(ctx, error);
    if (error instanceof HTTPException) return error.getResponse();
    // The message may carry user input or secrets: log only the name and the stack frames.
    logger.error({ reqId: ctx.get('requestId'), err: errorFields(error) }, 'unhandled error');
    return ctx.json({ error: { code: 'internal', message: 'Internal error' } }, 500);
  });
  app.notFound((ctx) =>
    ctx.req.path.startsWith('/api/')
      ? errorResponse(ctx, 'not_found', 'not found')
      : ctx.text('Not found', 404),
  );

  // Liveness = the database only (R17). The embedding model is deliberately not checked:
  // without it search degrades to full-text, so the app stays healthy.
  app.get('/healthz', async (ctx) => {
    let timer: NodeJS.Timeout | undefined;
    try {
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('healthz timeout')), HEALTHZ_TIMEOUT_MS);
      });
      await Promise.race([c.sql`select 1`, timeout]);
      return ctx.text('ok', 200);
    } catch {
      return ctx.text('fail', 503);
    } finally {
      clearTimeout(timer);
    }
  });

  // Every /api route except login, logout, the auth config and single sign-on needs a session
  // or a Bearer token (ADR 0008).
  const session = requireSessionOrToken(c.identity);
  app.use('/api/*', (ctx, next) =>
    PUBLIC_AUTH_PATHS.has(ctx.req.path) ? next() : session(ctx, next),
  );
  const search = async (query: string, folders?: string[]) =>
    (
      await searchSkills(c.search, {
        query,
        limit: SEARCH_LIMIT,
        ...(folders ? { folders } : {}),
      })
    ).map((h) => h.slug);
  app.route(
    '/api/auth',
    authRoutes(c.identity, {
      cookieSecure: config.cookieSecure,
      // The message may carry provider answers or user input: name and stack frames only.
      logError: (error, message) => logger.error({ err: errorFields(error) }, message),
    }),
  );
  const logins = (ids: string[]) => loginsByIds(c.identity, ids);
  app.route('/api/skills', skillRoutes(c.catalog, search, logins));
  app.route('/api/folders', folderRoutes(c.catalog));
  app.route('/api/tokens', tokenRoutes(c.identity, { publicUrl: config.publicUrl }));
  app.route('/api/users', userRoutes(c.identity));

  // MCP: its own Host/Origin checks and Bearer auth; outside /api, so session and CSRF skip it.
  const mcp = mcpRoute(c);
  app.all('/mcp', mcp.host, mcp.handle);

  const webRoot = opts.webRoot ?? DEFAULT_WEB_ROOT;
  if (existsSync(webRoot)) {
    app.use('/*', staticFiles(webRoot));
    app.use('/*', spaFallback(webRoot));
  }

  return { app, close: mcp.close };
}
