# Skills Registry

A self-hosted skills registry for Claude Code. It stores skills with full version history and serves
them to the agent over MCP (`search_skills`, `get_skill`, `list_folders`), so a team keeps its
skills in one place. Skills are grouped into folders:
`search_skills` takes an optional `folders` argument. Search is hybrid: full-text plus semantic,
using the built-in `multilingual-e5-small` model. Everything runs inside your own perimeter, with no
external services or API keys: the model ships in the image.

Besides MCP, there is a web UI for editing skills, tokens and users, a REST API, and a client CLI
that imports skills from public GitHub repositories and installs them for any agent.

Components: the `app` container (Node 22, port 3000, no TLS) and the `db` container
(Postgres 17 + pgvector, not exposed to the outside).

## Running

You need Docker and Docker Compose.

```bash
cp .env.example .env
# fill in .env:
#   POSTGRES_PASSWORD — openssl rand -base64 32
#   ADMIN_PASSWORD    — uncomment and set the first administrator's password (at least 12 characters)
#   PUBLIC_URL        — the address users reach the server at
docker compose up -d
```

Check: `curl http://localhost:3000/healthz` answers `ok`. On first start the server applies
migrations and, if there are no users yet, creates the administrator `ADMIN_LOGIN` / `ADMIN_PASSWORD`.

`/healthz` checks only the database. The embedding model is not part of it: while the model is
loading or unavailable, search works by words only, without semantics, and the server stays healthy.
The model is ready once the log shows the line `embedder ready`.

All settings, with explanations, are in [.env.example](./.env.example). Optional lines there are
commented out; an empty value (`KEY=`) counts as unset. `SESSION_SECRET` is reserved and currently
unused (sessions are random identifiers; the database stores their hash). If the settings contain
errors, the server prints the list of invalid variables, one per line, and exits with code 1.

## Web UI

Open `PUBLIC_URL` (for example, `http://localhost:3000`) and sign in as the administrator from
`ADMIN_LOGIN`/`ADMIN_PASSWORD`. The UI is in English and makes no external requests: fonts,
icons and styles are bundled.

- **Skills** — a list with search and a status filter, a skill page with its files, archiving.
- **New skill** — skills are created only in the editor (the "New skill" button in the list): slug,
  `SKILL.md` with frontmatter (`name`, `description`); additional files can be added or
  uploaded. Existing skills are edited there too; every save is a new version.
- **Tokens** — your own tokens for agents. A new token and the ready-made `claude mcp add …` command
  are shown once and can be copied with a button. Copying to the clipboard works only over
  HTTPS or on `localhost`; over plain HTTP the text is selected and has to be copied manually
  (Ctrl+C). Revoking asks for confirmation.
- **Users** (administrators only) — add (password at least 12 characters, role),
  reset a password, disable or enable. A disabled user cannot sign in, their sessions
  are ended and their tokens are revoked. You cannot disable yourself. With SSO, people are
  added and their passwords managed in the identity provider — see
  [Single sign-on](#single-sign-on-oidc).

If sign-in does not stick (after signing in you are back on the sign-in page), the server requires
HTTPS for the session cookie: open the service over `https://` or set `COOKIE_SECURE=false` on an
internal network.

## Single sign-on (OIDC)

SSO is optional. Without OIDC settings the server works as described above: users sign in to the
web UI with a login and password. When `OIDC_ISSUER`, `OIDC_CLIENT_ID` and `OIDC_CLIENT_SECRET` are
all set, the web UI signs in **only** through the identity provider (IdP). Setting some but not all
three is a configuration error: the server reports it and exits.

What changes in SSO mode:

- The sign-in page shows a single "Sign in with SSO" button; the password form is gone
  (`POST /api/auth/login` answers `403 sso_only`).
- API tokens (`sk_…`) on `/mcp` and `/api` keep working for every user, including password users
  created before SSO was turned on. Their agents and the client CLI need no changes.
- People are managed in the IdP: the "Users" page has no "New user" and no "Reset password"
  (`POST /api/users` and password resets answer `409 sso_managed`). Disabling and enabling users,
  tokens and sign-out work as before; disabling still ends sessions and revokes tokens.
- Access and role come from the person's IdP groups: a member of `OIDC_ADMIN_GROUP` is an `admin`,
  a member of `OIDC_LOGIN_GROUP` is a `member`, anyone else is refused. The role is re-synced on
  every SSO sign-in.
- The first SSO sign-in of an unknown person creates a user. Its login is taken from
  `preferred_username`, else the local part of the email, else the IdP subject (`sub`), adjusted to
  the login rules (`-2`, `-3`… on collision). The login is not changed on later sign-ins.
- `ADMIN_LOGIN`/`ADMIN_PASSWORD` are ignored (with a warning in the log). The first administrator is
  whoever signs in as a member of `OIDC_ADMIN_GROUP`.

### Provider setup

Any OIDC provider works if it can put the person's groups (or roles) into one claim of the ID token
or the UserInfo response: a list of names, or an object whose keys are the names. If the ID token
has no such claim, the server asks UserInfo.

1. Create two groups: the login group (`skills-users`) and the admin group (`skills-admins`).
   Membership in either lets a person in; the admin group also makes them an admin.
2. Create a confidential OIDC client (Authorization Code with a client secret):
   - redirect URI: `<PUBLIC_URL>/api/auth/sso/callback`, e.g.
     `https://skills.example.com/api/auth/sso/callback`;
   - PKCE allowed (the server always sends S256);
   - the groups claim is emitted (see the table below).
3. Put the issuer, client ID and secret into `.env` and restart: `docker compose up -d`.

| Provider                               | Settings                                                                                                                                                              |
| -------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Pocket ID, Authentik, Authelia, Kanidm | defaults                                                                                                                                                              |
| Keycloak                               | defaults; add a client scope `groups` with a Group Membership mapper (token claim name `groups`, "Full group path" off) and assign it to the client                   |
| Zitadel                                | `OIDC_SCOPES=openid profile email urn:zitadel:iam:org:projects:roles`, `OIDC_GROUPS_CLAIM=urn:zitadel:iam:org:project:roles`; use project roles named like the groups |

These are starting points, not tested recipes: check the claims your provider actually issues (for
example on its token preview page).

| Variable             | Default                       | Meaning                                                                                                          |
| -------------------- | ----------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `OIDC_ISSUER`        | unset                         | issuer URL; discovery at `<OIDC_ISSUER>/.well-known/openid-configuration` happens on the first sign-in           |
| `OIDC_CLIENT_ID`     | unset                         | client ID of the confidential client                                                                             |
| `OIDC_CLIENT_SECRET` | unset                         | client secret                                                                                                    |
| `OIDC_LOGIN_GROUP`   | `skills-users`                | members of this group may sign in (as `member`)                                                                  |
| `OIDC_ADMIN_GROUP`   | `skills-admins`               | members of this group may sign in and are admins                                                                 |
| `OIDC_SCOPES`        | `openid profile email groups` | scopes of the sign-in request, space- or comma-separated; must include `openid`                                  |
| `OIDC_GROUPS_CLAIM`  | `groups`                      | claim with the person's groups (ID token, else UserInfo): a list of names, or an object whose keys are the names |

`OIDC_ISSUER` must be exactly the `issuer` value from the discovery document (mind the trailing
slash): the server checks it on every sign-in. Check it with
`curl -s https://id.example.com/.well-known/openid-configuration`.

### Linking an existing account

The server never matches IdP accounts to existing users by name or email. A password user who
signs in through SSO for the first time gets a **new, separate** user. To keep one account (its
skill authorship and tokens), the operator links the IdP subject to the existing user:

```bash
docker compose exec app node dist/cli.js link-sso alice <sub>
```

`<sub>` is the person's subject identifier at the IdP. It is shown on the user's page in most
providers (Pocket ID, Authentik, Keycloak: the user ID). If the person has already signed in through
SSO, the subject is stored on the separate user that sign-in created:

```bash
docker compose exec db psql -U skills -d skills -c \
  "select login, oidc_sub, email, last_login_at from identity.users where oidc_sub is not null"
```

(The sign-in itself is in the audit log: `platform.audit_log`, action `auth.login`,
`meta.method = 'sso'`, `actor_id` is that user.)

A subject can be linked to only one user, so release it from the separate user first, link it,
then disable the separate user on the "Users" page:

```bash
docker compose exec app node dist/cli.js unlink-sso alice-2
docker compose exec app node dist/cli.js link-sso alice <sub>
```

From then on SSO sign-ins with that subject land on `alice`, and her role follows her IdP groups.
`link-sso` with the same pair again is a no-op; `unlink-sso <login>` removes the link (the next SSO
sign-in with that subject creates a new user again).

### Troubleshooting

A failed SSO sign-in returns to `/login?loginError=<code>`, and the page explains it:

| Code              | Meaning                                                                                                                              |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `idp_unavailable` | the server cannot reach `OIDC_ISSUER` (or discovery fails). `/mcp` and API tokens keep working; check the URL and the network        |
| `not_allowed`     | the person is in neither `OIDC_LOGIN_GROUP` nor `OIDC_ADMIN_GROUP`, or the groups claim is missing: check `OIDC_GROUPS_CLAIM`/scopes |
| `disabled`        | the user is disabled in the registry; enable them on the "Users" page                                                                |
| `invalid_state`   | the sign-in attempt expired (10 minutes) or was started in another browser; start again from the sign-in page                        |
| `internal`        | anything else (for example the code exchange or the issuer check failed); the reason is in the server log                            |

Failed attempts are also recorded in the audit log as `auth.login_failed` with `meta.reason`.

## Connecting Claude Code

Create a token (printed once) and the connect command:

```bash
docker compose exec app node dist/cli.js create-token admin --name laptop
```

The first line is the `sk_…` token, the second is the ready-made command:

```bash
claude mcp add --transport http skills http://localhost:3000/mcp --header "Authorization: Bearer sk_…"
```

Run it on the machine where Claude Code runs. Tokens can also be created and revoked
on the "Tokens" page of the web UI or via the REST API (`/api/tokens`).

## Creating skills

Skills are created in the web UI: "New skill" opens the editor, and saving sends
`POST /api/skills`. There is no bulk import of folders or zip archives; skills from public GitHub
are imported by the [client CLI](#client-cli).
New and changed skills are indexed for search in the background within seconds.

## Search

The `search_skills` result combines full-text and semantic search. A semantic
candidate is included only if its cosine similarity to the query is at least
`SEARCH_MIN_SIMILARITY` (0.80 by default). So an off-topic query returns an empty result. `score`
in the range 0..1 is the fraction of the best possible score: 1 means first place both by words and
by meaning. Measurements and the formula are in [ADR 0005](./docs/adr/0005-search-relevance-floor.md).

## Client CLI

`skills-registry` is a CLI for the user's machine (Node ≥ 22): it imports skills from public GitHub,
updates them from upstream and installs them for any agent (Claude Code, Codex, Cursor and others).
It talks to the server only over REST with an API token. It is not published to npm — build it from
the repository:

```bash
pnpm install && pnpm build:cli
cd packages/cli && npm link            # puts the skills-registry command on PATH
# or without link: node packages/cli/dist/cli.js <command>
```

Sign in (the token comes from the "Tokens" page or `create-token`; it is read from stdin and not echoed):

```bash
skills-registry login https://skills.example.com
```

The config is `~/.config/skills-registry/config.json` (mode `0600`). The variables
`SKILLS_REGISTRY_URL` and `SKILLS_REGISTRY_TOKEN` take precedence over the config (handy in CI).

```bash
# import: a folder in the registry is created from the skill name; --folder <slug> puts it in the given folder
# and creates that folder if it does not exist yet (an archived one is an error)
skills-registry import anthropics/skills --skill pdf --dry-run
skills-registry import https://github.com/anthropics/skills/tree/main/skills/pdf

# a new version from upstream if there is a new commit there; it overwrites registry edits with a warning,
# while upstream stays on the same commit, update downloads nothing and the edits are kept
skills-registry update pdf --dry-run
skills-registry update pdf

# install: a copy in ./.agents/skills/<slug>, links for agents; -g — into the home directory
skills-registry install pdf -a claude-code
skills-registry uninstall pdf -a claude-code
```

`GITHUB_TOKEN` (optional) raises the GitHub API rate limit. The repository is downloaded
as a whole archive; limits: `SKILLS_REGISTRY_MAX_TARBALL_BYTES` (compressed archive, 200 MiB by default)
and `SKILLS_REGISTRY_MAX_UNPACKED_BYTES` (unpacked, 1 GiB by default). `skills-registry` without
arguments prints help.

## Other CLI commands

```bash
# a user (the password is read from stdin; in interactive mode it is typed without echo)
read -rs -p 'Password: ' PW && printf '%s' "$PW" | docker compose exec -T app node dist/cli.js create-user bob --role member; unset PW

# rebuild the whole search index
docker compose exec app node dist/cli.js reindex
```

If the embedding model stays unavailable for a long time, an indexing event is given up after 10 attempts,
and the error `outbox: handler failed, giving up` is logged. Word search keeps working meanwhile.
As soon as the model is ready again, the server re-indexes documents without an embedding on its own
once a minute, 20 at a time. To restore everything at once, run `reindex`.

`node dist/cli.js` without arguments prints help.

## Backups

All data (skills, versions, users, tokens, index) lives in Postgres, in the `pgdata` volume.

```bash
# backup
docker compose exec -T db pg_dump -U skills -d skills -Fc > skills-$(date +%F).dump

# restore into the running database
docker compose exec -T db pg_restore -U skills -d skills --clean --if-exists < skills-2026-10-28.dump
docker compose restart app
```

## External database

Set `DATABASE_URL` in `.env` with the password inside the string. `docker-compose.yml` still requires
`POSTGRES_PASSWORD`: the variable is mandatory for the `db` service, and without it `docker compose`
will not start. Set any value. The `db` service will start as well. If you don't need it,
start only the application: `docker compose up -d --no-deps app`.

## Behind a reverse proxy (HTTPS)

The server does not terminate TLS itself. Put nginx, Traefik or Caddy in front of it and set in `.env`:

| Variable           | Value                                                                                                                                |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------ |
| `PUBLIC_URL`       | the external address, e.g. `https://skills.example.com`; the connect command is built from it and `Origin` is checked against it     |
| `TRUST_PROXY`      | `true` — take the client IP from `X-Forwarded-For` (for sign-in attempt limits)                                                      |
| `TRUST_PROXY_HOPS` | the number of trusted proxies in front of the server (`1` by default)                                                                |
| `ALLOWED_HOSTS`    | additional host names for `/mcp`, comma-separated. The host from `PUBLIC_URL`, `localhost` and `127.0.0.1` are allowed automatically |
| `COOKIE_SECURE`    | `true` (default) — session cookie over HTTPS only                                                                                    |

Without a proxy, keep `TRUST_PROXY=false`: otherwise a client can spoof its IP with the header.

## Manual check with Claude Code

1. `docker compose up -d`, create at least one code review skill in the web UI
   (see "Creating skills").
2. `docker compose exec app node dist/cli.js create-token admin --name check` and run
   the printed `claude mcp add …` command.
3. `claude mcp list` — the `skills` server is connected.
4. In a new Claude Code session, ask: "which skills do I have for code review?".
   Expected: the agent calls `search_skills`, then `get_skill` for the skill it found, and
   summarizes its content.

## Development

Requirements: Node 22+, pnpm 11, Docker (for integration tests on Testcontainers).

```bash
pnpm install
pnpm verify              # lint, format, types, architecture, knip, unit and integration tests
pnpm build               # server bundle: apps/server/dist/{main,cli}.js
bash scripts/smoke.sh    # build the image and check the whole box via docker compose
pnpm test:e2e            # Playwright (Chromium) against the web UI of the built image
```

For `pnpm test:e2e`, install the browser once: `pnpm exec playwright install chromium`.

Code structure and rules are in [CLAUDE.md](./CLAUDE.md), the specification is in `docs/superpowers/specs/`,
decisions are in `docs/adr/`.

## Contributing

Contributions are welcome — see [CONTRIBUTING.md](./CONTRIBUTING.md).

## Security

To report a vulnerability, see [SECURITY.md](./SECURITY.md).

## License

[MIT](./LICENSE)

Third-party components shipped in the image and the web bundle are listed in
[THIRD_PARTY_NOTICES.md](./THIRD_PARTY_NOTICES.md).
