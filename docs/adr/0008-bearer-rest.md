# 0008. Bearer token on REST

## Context

The client CLI (`docs/superpowers/specs/2026-10-29-client-cli-design.md`) needs access to `/api/*`: importing, updating and installing skills. Until now `/api/*` accepted only a session from the `sr_session` cookie, and mutating requests were checked against `Origin` (CSRF protection). `sk_…` tokens already exist but work only on `/mcp`. Giving the CLI a separate sign-in method (login and password, session in a file) would mean storing a password or a long-lived session on disk.

## Decision

1. `/api/*` accepts **either** a session from the cookie **or** an `Authorization: Bearer <token>` header (same format as MCP: `/^Bearer[ \t]+(\S+)$/i`). The token is checked by the same Identity function as on `/mcp` (`authenticateToken`): hash, revocation, disabled user, `lastUsedAt`, rate limiting of failed checks per IP.
2. Cookie and `Authorization` together → `400 invalid_request`: there must be no doubt whose principal it is.
3. Token error → `401` with `WWW-Authenticate: Bearer` (except `rate_limited` → `429` with `Retry-After`), as on `/mcp`. An `Authorization` header not in Bearer format → `401`; the request does not fall back to the session.
4. Bearer gives no access to `/api/tokens/**` and `/api/users/**` → `403 forbidden`: a token does not issue tokens and does not manage users. Available: `/api/skills/**`, `/api/folders/**` and `GET /api/auth/me` (the CLI uses it to check the token on connect).
5. The `Origin` check is skipped for a request with `Authorization` and without a session cookie. A browser cannot attach `Authorization` to a cross-site request without a CORS preflight, and the server does not allow CORS; such a request is authenticated by the token only anyway. A request with a cookie is checked against `Origin`, as before.
6. The request context has `authVia: 'session' | 'token'`; the audit log records the token owner's `actorId`, the same as for a session.

## Alternatives

- **A separate `/api/v1` prefix for tokens.** Two sets of routes with the same logic that must be kept in sync; the client and the UI drift apart in versions for no reason. Token restrictions (no `/api/tokens` and `/api/users`, no cookie) are expressed by one middleware on the shared prefix as well.
- **Token in a cookie.** The browser sends cookies by itself, so mutations again need the `Origin` check, and the CLI would have to emulate a browser. The "session or token" split by transport is lost.

## Consequences

- The CLI works with the same REST as the UI and the same token as MCP; one token per machine.
- A leaked token allows reading and changing skills and folders on behalf of its owner, but not issuing new tokens or managing users; revoking a token in the UI takes effect immediately.
- A new route under `/api` is accessible by token by default. A route that must stay session-only is added to the middleware's exclusion list.
