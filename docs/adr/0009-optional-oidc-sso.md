# 0009. Optional single sign-on (OIDC)

## Context

The web UI signs in only with a login and password stored in `identity.users` (`password_hash`). Administrators create users and reset passwords by hand, in the UI or with the server CLI. Teams that already run an identity provider want one account and central off-boarding instead of another password. The owner runs Pocket ID; the sibling project `mcp-registry` is OIDC-only and already has a working Authorization Code + PKCE flow with groups-based access (`apps/server/src/modules/identity`, `apps/web/src/auth/LoginPage.tsx`).

At the same time this registry is self-hosted by small teams, many of which have no provider. Existing installations have password users whose `sk_…` tokens are configured in agents and in the client CLI ([ADR 0008](./0008-bearer-rest.md)); turning SSO on must not break them.

Design: `docs/superpowers/specs/2026-10-30-sso-design.md`.

## Decision

1. **SSO is optional and the mode is chosen by configuration.** With `OIDC_ISSUER`, `OIDC_CLIENT_ID` and `OIDC_CLIENT_SECRET` all set, the web UI signs in only through the provider (`GET /api/auth/config` → `method: 'sso'`). With none of them set, only the password form (`method: 'password'`, the previous behaviour). A partial set is a configuration error at startup. In SSO mode `POST /api/auth/login` answers `403 sso_only`, creating users and resetting passwords answer `409 sso_managed`, and the `ADMIN_LOGIN`/`ADMIN_PASSWORD` bootstrap is skipped with a warning.
2. **The flow is a port of mcp-registry**: Authorization Code + PKCE (S256), `state` and `nonce`, a pending attempt stored for 10 minutes plus a login-binding cookie, `iss` checked; the session after the callback is the same session cookie as after a password login.
3. **Accounts are linked explicitly.** The provider's `sub` (`identity.users.oidc_sub`, unique) identifies a person. A first sign-in with an unknown `sub` creates a new user. An existing user is linked to a provider account only by the operator with the server CLI: `link-sso <login> <sub>` (fails if the `sub` belongs to another user) and `unlink-sso <login>`.
4. **Groups decide access and are re-synced on every sign-in.** `OIDC_ADMIN_GROUP` (default `skills-admins`) → `admin`, else `OIDC_LOGIN_GROUP` (default `skills-users`) → `member`, else the sign-in is refused (`not_allowed`). This also applies to linked users, so the provider is the source of truth for roles. Disabled users are refused.
5. **API tokens are unaffected.** `Bearer sk_…` on `/mcp` and `/api` works in both modes for every user, including password users that never sign in through SSO.

## Alternatives

- **Both methods at the same time** (password form and SSO button). Off-boarding in the provider would not close the password door, so an administrator would have to disable the user in two places; two sign-in paths also double what has to be secured and tested. Rejected: one mode per installation.
- **SSO only, as in mcp-registry.** Would force every installation to run a provider and would break existing password installations on upgrade. Rejected: the registry stays usable out of the box.
- **Automatic linking by username or email.** Whoever controls a provider account with a matching `preferred_username` or email (self-registration, an unverified email, a second provider later) would take over the existing user with its skills authorship and role. Rejected as an account-takeover risk; linking is an explicit operator action that names the exact `sub`.
- **Linking from the web UI.** Out of scope for now; the CLI covers the one-time migration of existing users.

## Consequences

- An installation without OIDC settings behaves exactly as before; no data migration is needed beyond the new nullable columns (`oidc_sub`, `email`, `groups`, `last_login_at`; `password_hash` becomes nullable) and the `identity.oidc_pending` table.
- After SSO is turned on, existing password users keep their tokens but cannot sign in to the web UI until they are linked (or they use the new user their first SSO sign-in creates). The README describes the linking procedure.
- Role changes made in the UI for SSO users are overwritten on the next sign-in; roles are managed through provider groups.
- A provider outage blocks web sign-in (`/login?loginError=idp_unavailable`) but not agents and the client CLI, which use tokens. Existing sessions stay valid.
- Single logout at the provider, SCIM provisioning and multiple providers are not supported: disabling a person in the provider stops new sign-ins, but their tokens and current sessions remain until the user is disabled in the registry.
