# Self-hosted skills registry with MCP access — design

Date: 2026-10-28
Status: draft for review

## 1. Why

The owner works with AI agents (Claude Code today, any harness later) across different projects and devices. Today:

- skills have to be copied from project to project;
- global skills have to be kept as copies on every device;
- every installed skill is loaded into the agent's startup context and burns tokens.

We need a single service inside a private network: it stores skills with version history, and the agent searches for them and loads them **on the fly**, only when needed. The agent connects to the service over MCP with a single command; nothing is installed on the device.

The idea is the same as [nikships/skills-registry](https://github.com/nikships/skills-registry) (only a pointer in the context, skills on demand), but without git and GitHub: our own server, our own database, access over MCP, management through a web UI.

## 2. Goals

1. A single skills store, reachable from any device and any MCP-compatible harness.
2. Immutable version history for every skill: view, compare, roll back.
3. Search: full-text + semantic (by meaning), in Russian and English.
4. Minimal token usage: the agent's context holds only the descriptions of three MCP tools (`search_skills`, `get_skill`, `list_folders`) and a short server instruction. For folders and `list_folders`, see `2026-10-29-skill-folders-design.md` and ADR 0007.
5. "Out of the box": `docker compose up`, with no paid external services, accounts or API keys.
6. Skills are managed through a web UI.
7. High code quality, a DDD architecture, and a harness that keeps that quality up, including when agents write the code.

## 3. Non-goals (for now)

- Searching for skills on the internet (GitHub, SkillNet, etc.). ~~Importing from the internet~~ — dropped 2026-10-29: import from public GitHub on an explicit human command in the client CLI ([CLI spec](./2026-10-29-client-cli-design.md)).
- Importing skills from a folder or a zip archive (UI, REST `/api/import`, CLI command `import`). It was implemented and then removed by the owner's decision on 2026-10-29: skills are created only in the UI editor (`POST /api/skills`).
- Open source / a public product: only the owner and colleagues install it.
- Pinning a skill version on the agent side: the agent **always gets the latest version**.
- Publishing and editing skills over MCP: only through the UI.
- Fine-grained permissions: at the start, every user can read and change every skill.
- A git-based store.
- ~~Delivering skill files to the agent's disk~~ — dropped 2026-10-29: the client CLI's `install` command ([CLI spec](./2026-10-29-client-cli-design.md)). The server still runs nothing (`scripts/` are not executed). The trust model is unchanged: a human reviews every skill before publishing; import and update from GitHub are started by a human with their own token.
- OAuth for MCP (needed by Claude Desktop / claude.ai). The first consumer is Claude Code with a token in a header; access checks are designed so that OAuth can be added later without a rewrite.
- TLS and public exposure: the application listens on `0.0.0.0` inside the container; the owner sets up proxying and HTTPS.

## 4. Anti-goals (failure, even if it "works")

- A paid external API or an account with a third-party provider is required.
- Connecting an agent takes more than one `claude mcp add …` command.
- The agent has to load the whole skill with all its files just to read one `SKILL.md`.
- A skill change can get lost from the search index or from history.
- Layers and modules are tangled, and boundaries are held only by discipline, without automated checks.

## 5. Constraints

- Deployed inside a private network on the owner's server, via Docker Compose. The server has internet access, but the service must not depend on it at runtime.
- Users: one for now (the owner), colleagues later. User accounts are built in from the start.
- The skill format is compatible with Agent Skills: a folder with `SKILL.md` (YAML frontmatter `name`, `description` + markdown body) and arbitrary nested files (`scripts/`, `references/`, `assets/`, etc.).

## 6. Decisions made with the owner

| Area | Decision |
|---|---|
| Storage | PostgreSQL, no git |
| Versions | Every change creates a new immutable version; the agent always gets the latest |
| Agent access | MCP over HTTP (Streamable HTTP), Bearer token in a header |
| MCP tools | Only `search_skills`, `get_skill` and `list_folders` (folders: `2026-10-29-skill-folders-design.md`, ADR 0007) |
| Management | Web UI |
| Search | Full-text + semantic |
| Embeddings | Local, free, no external APIs |
| Language and server | TypeScript, Node.js, Hono |
| MCP SDK | Official `@modelcontextprotocol/server` + `@modelcontextprotocol/hono` (no `mcp-handler`) |
| Embeddings in code | Through the AI SDK abstraction (`embed`/`embedMany`) or our own port; the provider is switched by config |
| Database | PostgreSQL + pgvector |
| UI | React + Vite |
| Deployment | A single `docker compose` |
| Lint/format/types | Vite+ (`vp check`: type-aware Oxlint, Oxfmt, tsc) |
| Tests | Vite+ (`vp test` = Vitest) |
| Architecture | DDD, modular monolith, ports & adapters |

## 7. Decisions made by me (please review)

- **Modular monolith**, not microservices: one application process + Postgres.
- **In-process embedding model** via `transformers.js` (ONNX), `multilingual-e5-small` (384 dimensions), weights baked into the Docker image: works offline, no separate container needed. Ollama or an OpenAI-compatible endpoint can be plugged in by config.
- **Rollback = a new version** with the old content. History is linear; nothing is erased.
- **Files are stored by sha256** (content-addressed); unchanged files are not duplicated across versions.
- **Indexing via a transactional outbox**: the `SkillVersionCreated` event is written in the same transaction as the version; a background worker in the same process updates the search index.
- **Optimistic locking**: saving a new version from the UI passes the base version number; if the skill has already been changed, the server responds with a conflict.
- **Deletion = archiving** (the skill is hidden from search and MCP, history is kept); restoring from the archive is available in the UI.
- **UI accounts**: login + password (argon2id), session in an httpOnly cookie. The first administrator is created from environment variables on first start. Roles: `admin` (manages users) and `member`.
- **API tokens** for MCP are created by the user in the UI; the token is shown once, and only its hash is stored in the database. A token can be revoked.
- **UI language**: English.
- **Network**: the application listens for HTTP on `0.0.0.0:<PORT>`; there is no reverse proxy in compose. The service is designed to run behind someone else's proxy (see §11.1).
- **First consumer = Claude Code** (the owner answered "claude"; I read that as Claude Code, since they already approved connecting with a token in a header).

## 8. Architecture

### 8.1 Overview

```
Claude Code / any harness ──MCP/HTTP + Bearer──▶ ┌──────────── app (Node.js + Hono) ────────────┐
Browser ──────────────────────HTTP + cookie────▶ │ interfaces: MCP adapter │ REST /api │ UI static │
                                                 │ modules:   Catalog │ Search │ Identity        │
                                                 │ outbox worker (in the same process)           │
                                                 └───────────────────────┬──────────────────────┘
                                                                         ▼
                                                      PostgreSQL + pgvector (one schema per module)
```

### 8.2 Modules (bounded contexts)

**Catalog** — the core.
- Aggregate `Folder`: `slug`, `name`, `description`, `status` (`active` | `archived`); every skill lives in exactly one folder. Details: `docs/superpowers/specs/2026-10-29-skill-folders-design.md`.
- Aggregate `Skill`: `id`, `slug` (unique, kebab-case), folder, `status` (`active` | `archived`), `currentVersion`.
- Entity `SkillVersion` (immutable): `number` (1, 2, 3… within the skill), `name`, `description` (from frontmatter), `files` (manifest: path → sha256, size), `authorId`, `message` (optional change comment), `createdAt`, `restoredFrom?` (version number, if this is a rollback).
- Value objects: `Slug`, `VersionNumber`, `ContentHash`, `FilePath` (normalized relative path, no `..`), `SkillManifest`.
- Invariants: every version has a `SKILL.md` with valid frontmatter (`name` and `description` are required); `name` in the frontmatter matches the `slug`; file paths are unique and safe.
- Use cases: `CreateSkill`, `PublishSkillVersion`, `RollbackSkill`, `ArchiveSkill`, `RestoreSkill`, `MoveSkill`; folders: `CreateFolder`, `UpdateFolder`, `ArchiveFolder`, `RestoreFolder`; queries `ListFolders`, `GetSkill`, `GetSkillFile`, `ListSkills`, `GetSkillHistory`, `DiffVersions`.
- Events: `SkillVersionCreated`, `SkillArchived`, `SkillRestored`, `SkillMoved`.
- File storage: a blob table (`sha256` → `bytea`), port `BlobStore`.

**Search** — a read model.
- One index document per skill (only the latest version of an active skill): `slug`, `name`, `description`, `SKILL.md` text, `tsvector` (`russian` + `english` configurations), embedding vector.
- The embedding is computed from `name + description + the beginning of the SKILL.md body` (with the `passage:` prefix for e5); queries use the `query:` prefix.
- Ranking: hybrid FTS + vector via Reciprocal Rank Fusion.
- Port `Embedder`; adapters: `transformers.js` (default), OpenAI-compatible HTTP.
- Subscribes to Catalog events via the outbox; `SkillArchived` deletes the document, `SkillRestored` and `SkillVersionCreated` recompute it.
- A full reindex command (in case the model changes).

**Identity**
- `User` (login, password hash, role), `ApiToken` (hash, name, `lastUsedAt`, `revokedAt`), UI sessions.
- Use cases: log in/out, create/revoke a token, user management (admin).
- Exposes to other modules only token/session verification → `Principal`.

### 8.3 Layers inside a module

```
interfaces      → MCP tools, HTTP routes, zod input validation
application     → use cases and queries; declares ports (repositories, BlobStore, Embedder, Clock, EventPublisher)
domain          → aggregates, value objects, events, invariants. Pure TypeScript, no dependencies
infrastructure  → port implementations: Postgres repositories, blob, embedder, outbox
```

Rules (checked automatically):
- `domain` imports nothing outside its own `domain` (except the dependency-free shared `shared-kernel`).
- `application` imports only its own module's `domain`.
- Modules communicate only through a module's public `index.ts` or through domain events. Importing another module's internals is forbidden.
- `infrastructure` and `interfaces` are not imported from `domain` or `application`.
- Each module owns its own database schema (`catalog.*`, `search.*`, `identity.*`); other modules' tables are not read directly.

### 8.4 Repository structure

```
apps/server/src/
  modules/catalog/{domain,application,infrastructure,interfaces}
  modules/search/{...}
  modules/identity/{...}
  shared-kernel/            # Result, base event types, domain errors
  platform/                 # composition: DI, config, Hono app, outbox worker, migrations
apps/web/                   # React + Vite UI
packages/contracts/         # REST API zod schemas, shared by server and UI
docs/adr/                   # architecture decisions
```

pnpm workspaces.

## 9. MCP interface

Transport: Streamable HTTP, endpoint `/mcp`, header `Authorization: Bearer <token>`. No token or a revoked one → 401.

Connecting:
```
claude mcp add --transport http skills https://<host>/mcp --header "Authorization: Bearer <token>"
```
The UI shows this command, ready to copy, right after a token is created.

**Server instructions** (the `instructions` field at initialization, short): before starting a task that needs specialized knowledge or a process, call `search_skills`; if a suitable skill is found, load it via `get_skill`, read `SKILL.md`, and fetch further files as needed via `get_skill` with `path`. Skills are grouped into folders: if the task clearly belongs to some of them, call `list_folders` and pass their slugs to `search_skills`; otherwise search everything.

**`search_skills(query: string, limit?: number = 10, max 25, folders?: string[])`**
→ a list of `{ slug, name, description, folder, score }`, sorted by relevance. Archived skills are not returned. `folders` (slugs from `list_folders`, 1–20) restricts the search to those folders; an unknown or archived slug → tool error `Unknown folder "<slug>". Call list_folders.`

**`list_folders()`**
→ `{ folders: [{ slug, name, description, skills }] }`: active folders sorted by `name`; `skills` is the number of active skills.

**`get_skill(slug: string, path?: string)`**
- without `path` → `{ slug, version, name, description, folder, skillMd: <full text of SKILL.md>, files: [{ path, size }] }` (a list of all files except SKILL.md, without content);
- with `path` → the content of one text file from the latest version. For a binary file — a clear refusal ("binary file, N bytes, available only in the UI");
- an unknown slug, archived skill or path → a clear tool error.

## 10. Web UI (minimum scope)

- Login with username/password.
- Skills list with search (the same search as MCP), filter "active / archived".
- Skill page: rendered `SKILL.md`, file tree, file viewer.
- Creating and editing: an in-browser editor for `SKILL.md` and text files, adding/removing/uploading files, a change comment. Saving = a new version.
- ~~Import: uploading a folder or zip with one or more skills~~ — removed by the owner's decision on 2026-10-29 (see §3): skills are created only in the editor.
- Version history: list, view any version, diff between two versions, rollback.
- Archiving and restoring.
- My API tokens: create (with a ready-made connect command), revoke, last use is visible.
- Users (admin only): create, reset password, disable.

## 11. Deployment

- `docker-compose.yml`: `app` (server + built UI + model weights, listens on `0.0.0.0`), `db` (`pgvector/pgvector`, volume, port not published).
- Configuration via `.env` with an `.env.example`: database connection string, initial admin, session secret, public URL, `TRUST_PROXY`, `COOKIE_SECURE`, embedding provider choice.
- Migrations are applied automatically on application start.
- Healthcheck: `/healthz` without authentication, responds only `ok`/`fail` with no details (process alive, database reachable; the embedding model is intentionally not checked: without it, search degrades to full-text, R17).
- Backup: a documented `pg_dump` command (all history and files are in one database).
- The `app` container runs as an unprivileged user.

### 11.1 Security (mandatory from the first version)

The service sits on the internal network behind the owner's proxy, but is protected as if there were no proxy.

- **Passwords**: argon2id; a minimum length; identical response and timing for "no such user" and "wrong password".
- **Brute force**: rate limit on login (per IP and per login) with temporary lockout; rate limit on failed Bearer token checks per IP.
- **Tokens**: 256 bits of randomness, a recognizable prefix (`sk_…`) for leak scanning, only the hash (SHA-256) in the database, constant-time comparison, revocation takes effect immediately, `lastUsedAt`.
- **Sessions**: httpOnly, `SameSite=Strict`, `Secure` per `COOKIE_SECURE` (on by default), id rotation on login, idle and absolute expiry.
- **CSRF**: `SameSite=Strict` + `Origin`/`Host` check on all mutating `/api` requests.
- **Proxy**: `X-Forwarded-*` is honored only when `TRUST_PROXY` is set (otherwise the per-IP rate limit could be bypassed by spoofing the header).
- **HTTP headers**: CSP without inline scripts, `X-Content-Type-Options`, `Referrer-Policy`, `frame-ancestors 'none'`. Markdown in the UI is rendered with sanitization.
- **Input**: zod at every boundary; limits on request body, file and skill size; file paths are normalized, path traversal is forbidden (zip import with protection against zip-slip, symlinks and zip bombs was removed 2026-10-29, see §3).
- **MCP**: `Origin` and `Host` checks as recommended by the MCP specification (DNS rebinding protection); no token → 401.
- **Authorization**: access checks in the application layer, not only in routes; `admin` operations checked separately.
- **Audit**: a log of logins, token creation/revocation, publications, rollbacks, archiving, user management.
- **Logs**: no passwords, tokens, cookies or skill content.
- **Dependencies**: `pnpm audit` in CI; a lockfile is mandatory.
- **Security tests**: integration tests for 401/403, rate limits, CSRF, revoked tokens, unsafe file paths.

## 12. Quality harness

| What | Tool |
|---|---|
| Lint, format, types | `vp check` (type-aware Oxlint, Oxfmt, tsc). TypeScript `strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes` |
| Architecture boundaries | `dependency-cruiser` with the rules from §8.3 |
| Dead code | `knip` |
| Unit tests | `vp test` (Vitest): domain and application with fake ports, no database |
| Integration | Vitest + Testcontainers (real Postgres + pgvector): repositories, outbox, search |
| MCP contract | a real MCP client against a running server: auth, both tools, errors |
| UI E2E | Playwright: login, creating a skill, editing → new version, rollback, creating a token |
| One command | `pnpm verify` = `vp check` + depcruise + knip + `vp test` |
| Git hooks | lefthook: on commit — `vp check` on changed files; on push — `pnpm verify` |
| CI | the same `pnpm verify` + integration + e2e |
| For agents | `CLAUDE.md` and `AGENTS.md`: layers, import rules, domain glossary (Skill, Version, Manifest…), a "how to add a use case" recipe; a Claude Code PostToolUse hook runs `vp check` on the changed file; an ADR in `docs/adr/` for every significant decision |
| Coverage | a threshold for `domain` and `application` (value left to the implementer, target 90%) |

## 13. Left to the implementer

- ORM / query builder and migration tool (target: Drizzle or Kysely).
- UI editor (CodeMirror / Monaco), diff library, UI kit.
- Size limits (file, skill), length of the body fragment used for embedding.
- DI style (manual composition in `platform/` is preferred over a container).
- Specific RRF parameters and search weights.
- CI platform (depends on where the repository will live inside the network).
- If `@modelcontextprotocol/*` v2 turns out to be unstable at the start — v1 SDK + `@hono/mcp`, with no change to the architecture.
