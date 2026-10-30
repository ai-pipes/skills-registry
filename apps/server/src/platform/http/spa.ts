import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { serveStatic } from '@hono/node-server/serve-static';
import type { MiddlewareHandler } from 'hono';

const RESERVED = ['/api', '/mcp', '/healthz'];
const isReserved = (path: string): boolean =>
  RESERVED.some((p) => path === p || path.startsWith(`${p}/`));

/** Static files from the built UI; hashed `/assets/*` are cached forever. */
export function staticFiles(webRoot: string): MiddlewareHandler {
  const files = serveStatic({ root: webRoot });
  return async (c, next) => {
    // Set before serveStatic builds its response: headers added afterwards miss the returned one.
    if (c.req.path.startsWith('/assets/')) {
      c.header('Cache-Control', 'public, max-age=31536000, immutable');
    }
    const res = await files(c, next);
    // A miss falls through to a 404 that must not be cached forever.
    if (c.res.status >= 400) c.res.headers.delete('Cache-Control');
    return res;
  };
}

/**
 * Client-side routes: a browser navigation (GET/HEAD, Accept text/html) to an extensionless
 * path outside /api, /mcp and /healthz gets index.html. Everything else falls through.
 */
export function spaFallback(webRoot: string): MiddlewareHandler {
  const indexPath = join(webRoot, 'index.html');
  return async (c, next) => {
    const { method } = c.req;
    const path = c.req.path;
    const last = path.split('/').at(-1) ?? '';
    if (
      (method !== 'GET' && method !== 'HEAD') ||
      isReserved(path) ||
      last.includes('.') ||
      !(c.req.header('accept') ?? '').includes('text/html')
    ) {
      return next();
    }
    let html: string;
    try {
      html = await readFile(indexPath, 'utf8');
    } catch {
      return next();
    }
    c.header('Cache-Control', 'no-cache');
    return c.html(html);
  };
}
