import { isIP } from 'node:net';
import { getConnInfo } from '@hono/node-server/conninfo';
import type { Context, MiddlewareHandler } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { secureHeaders } from 'hono/secure-headers';
import type { AppEnv } from './env.ts';
import { errorResponse } from './errors.ts';

/**
 * CSP without inline scripts or styles; the UI is served from the same origin and inserts no
 * <style> element (ADR 0006), so there is no style-src-elem exception.
 */
export const securityHeaders = (): MiddlewareHandler =>
  secureHeaders({
    contentSecurityPolicy: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'"],
      styleSrc: ["'self'"],
      imgSrc: ["'self'", 'data:'],
      frameAncestors: ["'none'"],
    },
    referrerPolicy: 'no-referrer',
    xContentTypeOptions: 'nosniff',
  });

const DEFAULT_BODY_LIMIT = 1_048_576;

const onError = (c: Context) => errorResponse(c, 'limit_exceeded', 'request body is too large');

/**
 * Caps a body before it is buffered: by Content-Length up front, otherwise while streaming.
 * Upload routes mount it themselves, after the session check, with their larger cap.
 */
export const limitBody = (maxSize: number): MiddlewareHandler => bodyLimit({ maxSize, onError });

/**
 * The global 1 MiB cap. Requests for which `isUpload` holds skip it: their route applies
 * `limitBody` with the upload cap, so an anonymous client can never make the server buffer
 * more than 1 MiB.
 */
export function defaultBodyLimit(
  isUpload: (method: string, path: string) => boolean,
): MiddlewareHandler {
  const limit = limitBody(DEFAULT_BODY_LIMIT);
  return (c, next) => (isUpload(c.req.method, c.req.path) ? next() : limit(c, next));
}

/** Socket peer address from @hono/node-server; 'unknown' outside a Node server. */
export function socketAddress(c: Context): string {
  try {
    return getConnInfo(c).remote.address ?? 'unknown';
  } catch {
    return 'unknown';
  }
}

/**
 * The X-Forwarded-For hop `hops` entries from the right, i.e. the address the outermost of
 * `hops` trusted proxies saw. Proxies append on the right, so everything further left is
 * client-controlled. Null when the header is too short or the hop is not an IP.
 */
function forwardedFor(header: string | undefined, hops: number): string | null {
  if (!header) return null;
  const list = header.split(',').map((h) => h.trim());
  const hop = list[list.length - hops];
  return hop !== undefined && isIP(hop) !== 0 ? hop : null;
}

/**
 * Resolves the client IP: the socket peer, or with `trustProxy` the X-Forwarded-For hop
 * `trustProxyHops` from the right (falling back to the peer). Without `trustProxy` the header
 * is ignored, otherwise anyone could pick their own rate-limit key.
 */
export function clientIp(opts: {
  trustProxy: boolean;
  trustProxyHops: number;
  remoteAddress: (c: Context) => string;
}): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const forwarded = opts.trustProxy
      ? forwardedFor(c.req.header('x-forwarded-for'), opts.trustProxyHops)
      : null;
    c.set('clientIp', forwarded ?? opts.remoteAddress(c));
    await next();
  };
}

const UNSAFE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/**
 * Mutating /api requests must carry an Origin equal to the public URL's origin, except token
 * requests (`isTokenRequest`): a browser cannot attach an Authorization header cross-site
 * without a CORS preflight, which the server never grants (ADR 0008).
 */
export function csrf(
  publicUrl: string,
  opts: { isTokenRequest: (c: Context) => boolean },
): MiddlewareHandler {
  const expected = new URL(publicUrl).origin;
  return async (c, next) => {
    const path = c.req.path;
    const isApi = path === '/api' || path.startsWith('/api/');
    if (
      isApi &&
      UNSAFE_METHODS.has(c.req.method) &&
      c.req.header('origin') !== expected &&
      !opts.isTokenRequest(c)
    ) {
      return errorResponse(c, 'csrf', 'cross-origin request rejected');
    }
    return next();
  };
}
