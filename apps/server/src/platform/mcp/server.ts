import { hostHeaderValidation } from '@modelcontextprotocol/hono';
import { type AuthInfo, createMcpHandler, McpServer } from '@modelcontextprotocol/server';
import type { Handler, MiddlewareHandler } from 'hono';
import { authenticateToken, type Principal } from '../../modules/identity/index.ts';
import { errorFields } from '../../shared-kernel/index.ts';
import type { Container } from '../container.ts';
import type { AppEnv } from '../http/env.ts';
import { domainErrorResponse, errorResponse } from '../http/errors.ts';
import { SERVER_INSTRUCTIONS } from './instructions.ts';
import { registerTools } from './tools.ts';

const SERVER_VERSION = '0.0.0';

/**
 * One MCP server per request, for one authenticated principal. Every user reads the whole
 * library, so the principal does not change what the tools return; it is the hook for
 * per-user behaviour and keeps an unauthenticated server impossible to build.
 */
function buildMcpServer(c: Container, principal: Principal): McpServer {
  void principal;
  const server = new McpServer(
    { name: 'skills', version: SERVER_VERSION },
    { instructions: SERVER_INSTRUCTIONS },
  );
  registerTools(server, c);
  return server;
}

function isPrincipal(v: unknown): v is Principal {
  return (
    typeof v === 'object' &&
    v !== null &&
    'userId' in v &&
    typeof v.userId === 'string' &&
    'via' in v &&
    v.via === 'token'
  );
}

/** The principal set by the Bearer check; throws if the handler was reached without one. */
function principalOf(authInfo: AuthInfo | undefined): Principal {
  const principal = authInfo?.extra?.['principal'];
  if (!isPrincipal(principal)) throw new Error('MCP request without an authenticated principal');
  return principal;
}

/** Hostnames accepted in `Host`: the configured ones, the public URL's, and loopback. */
function mcpAllowedHosts(config: Container['config']): string[] {
  const hosts = [
    ...config.allowedHosts,
    new URL(config.publicUrl).hostname,
    'localhost',
    '127.0.0.1',
  ];
  return [...new Set(hosts.map((h) => h.toLowerCase()))];
}

const BEARER = /^Bearer[ \t]+(\S+)$/i;

/**
 * `/mcp` (Streamable HTTP). Order: Host → Origin → Bearer token → MCP handler.
 * Body size is capped by the global 1 MiB limit; `/mcp` is outside `/api`, so neither the
 * session middleware nor the CSRF check applies. The token is never passed on or logged:
 * the handler gets `'<redacted>'` and the resolved principal.
 */
export function mcpRoute(c: Container): {
  host: MiddlewareHandler;
  handle: Handler<AppEnv>;
  /** Aborts in-flight MCP exchanges; call on shutdown after the HTTP server stops accepting. */
  close: () => Promise<void>;
} {
  const expectedOrigin = new URL(c.config.publicUrl).origin;
  const handler = createMcpHandler((ctx) => buildMcpServer(c, principalOf(ctx.authInfo)), {
    onerror: (error) => c.logger.warn({ err: errorFields(error) }, 'mcp error'),
  });

  const handle: Handler<AppEnv> = async (ctx) => {
    const origin = ctx.req.header('origin');
    if (origin !== undefined && origin !== expectedOrigin) {
      return errorResponse(ctx, 'forbidden', 'origin not allowed');
    }
    const match = BEARER.exec(ctx.req.header('authorization') ?? '');
    if (!match?.[1]) {
      ctx.header('WWW-Authenticate', 'Bearer');
      return errorResponse(ctx, 'unauthenticated', 'bearer token required');
    }
    const auth = await authenticateToken(c.identity, {
      token: match[1],
      ip: ctx.get('clientIp'),
    });
    if (!auth.ok) {
      if (auth.error.code !== 'rate_limited') ctx.header('WWW-Authenticate', 'Bearer');
      return domainErrorResponse(ctx, auth.error);
    }
    const principal = auth.value;
    return handler.fetch(ctx.req.raw, {
      authInfo: {
        token: '<redacted>',
        clientId: principal.userId,
        scopes: [],
        extra: { principal },
      },
    });
  };

  return {
    host: hostHeaderValidation(mcpAllowedHosts(c.config)),
    handle,
    close: () => handler.close(),
  };
}
