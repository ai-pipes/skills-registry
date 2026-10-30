# Single sign-on (OIDC) — design

Status: approved by the owner, 2026-10-30. Reference implementation: the sibling project
`mcp-registry` (`apps/server/src/modules/identity`, `apps/web/src/auth/LoginPage.tsx`), which is
OIDC-only. Here SSO is **optional**: without OIDC settings the server works exactly as today.

## Decisions

1. **Mode is chosen by configuration.** If `OIDC_ISSUER`, `OIDC_CLIENT_ID` and `OIDC_CLIENT_SECRET`
   are all set, the web UI signs in **only** through SSO (method `sso`). If none is set, only the
   password form (method `password`, today's behaviour). Setting some but not all is a config error.
2. **API tokens are untouched.** `Bearer sk_…` on `/mcp` and `/api` works in both modes for every
   user, including password users created before SSO was enabled.
3. **Linking is explicit.** The provider's issuer + `sub` identify a person. A first SSO login with an
   unknown `sub` creates a new user. An existing (password) user is linked to a provider account
   only by the operator: server CLI `link-sso <login> <sub>`. No automatic matching by name/email.
4. **Groups decide access**, as in mcp-registry: `OIDC_ADMIN_GROUP` → `admin`, else
   `OIDC_LOGIN_GROUP` → `member`, else the login is refused (`not_allowed`). Role is re-synced from
   the groups on every SSO login (also for linked users). `disabled` users are refused.

## Configuration (`apps/server/src/platform/config.ts`)

| Variable | Default | Meaning |
| --- | --- | --- |
| `OIDC_ISSUER` | — | Issuer URL (discovery at `/.well-known/openid-configuration`) |
| `OIDC_CLIENT_ID` / `OIDC_CLIENT_SECRET` | — | Confidential client; redirect URI is `<PUBLIC_URL>/api/auth/sso/callback` |
| `OIDC_LOGIN_GROUP` | `skills-users` | Group that may sign in |
| `OIDC_ADMIN_GROUP` | `skills-admins` | Group that makes a person an admin |
| `OIDC_SCOPES` | `openid profile email groups` | Space/comma separated, must include `openid` |
| `OIDC_GROUPS_CLAIM` | `groups` | Claim with groups (list of strings, or object whose keys are names); UserInfo fallback |
| `OIDC_ALLOW_INSECURE` | `false` | `OIDC_ISSUER` must be `https:` unless this is `true` (config error otherwise) |

In SSO mode `ADMIN_LOGIN`/`ADMIN_PASSWORD` bootstrap is skipped with a warning.

## Data (migration `0010_identity_sso.sql`)

`identity.users`: `password_hash` becomes nullable (SSO-created users have none); add
`oidc_iss text`, `oidc_sub text`, unique `(oidc_iss, oidc_sub)`, both null or both set (null = not
linked; the issuer is the configured `OIDC_ISSUER`, so changing it never lands on old accounts),
`email text`, `groups text[] not null default '{}'`, `last_login_at timestamptz`. New table
`identity.oidc_pending` exactly as in mcp-registry (`state` PK, `code_verifier`, `nonce`,
`return_to`, `expires_at` + index); expired rows are deleted on every insert.

A user created by SSO gets a unique `login` derived from `preferred_username`, else the email's
local part (only with `email_verified: true`), else `sub`: NFKC-normalised, lower-cased, reduced to
`[a-z0-9._-]` (other runs become `-`, trimmed, capped at 128), `user` if empty, with `-2`, `-3`… on
collision. `login` is what the UI shows as an author; it is not updated on later logins.

## Flow (port of mcp-registry, routes under `/api/auth`)

- `GET /api/auth/config` (public) → `AuthConfigResponse { method }`.
- `GET /api/auth/sso/login?returnTo=` → Authorization Code + PKCE (S256), `state`, `nonce`;
  at most 30 starts per IP per 10 min (`302 /login?loginError=rate_limited`); `returnTo` is
  normalized and longer than 512 characters becomes `/`; pending attempt stored for 10 min; a login-binding cookie (`HttpOnly`, `SameSite=Lax`,
  `path=/api/auth`, 10 min) carries the `state`; redirect 302 to the provider.
  Provider unreachable → `302 /login?loginError=idp_unavailable`.
- `GET /api/auth/sso/callback?code&state[&iss]` → binding cookie must equal `state`; pending
  attempt consumed once; code exchanged (`openid-client`, nonce + PKCE + `iss` checked); groups from
  the ID token or UserInfo; policy (a refused, already known person's web sessions are deleted, audit
  meta `sessionsRevoked: true`; tokens stay); upsert by (issuer, `sub`); session created exactly like a password login
  (same cookie, same TTL); audit `auth.login` (meta `{ method: 'sso' }`) or `auth.login_failed`
  (meta `{ reason, method: 'sso' }`); `302` to the normalized `returnTo` (same-origin relative path
  only). Any failure → `302 /login?loginError=<SsoLoginError>`; unexpected errors are logged and
  become `internal`; a rejected code exchange stays `invalid_state` and is logged as a warning with
  the OAuth `error` / library error code only.
- In SSO mode: `POST /api/auth/login` (password) → `403 { code: 'sso_only' }`; creating users and
  resetting passwords (`POST /api/users`, `…/password`) → `409 { code: 'sso_managed' }`. Disable /
  enable, tokens, logout, `/me` work as before. Disabling a user still revokes sessions and tokens.
- Both modes: `UserSummary` gains `sso`, `email`, `lastLoginAt`; password logins also set
  `last_login_at`.
- Server CLI (`apps/server/src/platform/cli-commands.ts`): `link-sso <login> <sub>` (stores the configured issuer, so it needs OIDC settings; fails if the `sub` is
  linked to another user; idempotent for the same pair) and `unlink-sso <login>`.

Layering follows CLAUDE.md: `domain/` gets the pure parts (`accessFor`, `normalizeReturnTo`,
login-state expiry, login derivation); `application/` gets `startSsoLogin`/`completeSsoLogin`
and ports `OidcProvider`, `PendingLoginRepository`; `infrastructure/` gets `OpenidProvider`
(`openid-client`, lazy discovery with a 5 s timeout, outage → `idp_unavailable`) and Postgres
repositories; `interfaces/http` gets the routes and cookies. Integration tests use a fake OIDC
provider (port `mcp-registry/apps/server/test/identity/fake-idp.ts`).

## Web UI

- `LoginPage` asks `GET /api/auth/config`. `password` → today's form. `sso` → a single
  "Sign in with SSO" link to `/api/auth/sso/login?returnTo=<next>` (a plain `<a>`, a top-level
  navigation, so CSP is unaffected), and an `ErrorAlert` for `?loginError=` (known codes from
  `SsoLoginError` with their own text, anything else generic).
- Users page in SSO mode: no "New user" and no "Reset password"; a short note that people are
  managed in the identity provider; columns/badges for SSO-linked users, email and last sign-in.
- All strings in `strings.ts`, English.

## Out of scope

Single logout at the provider, SCIM/provisioning, multiple providers, linking from the UI.
