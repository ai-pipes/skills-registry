# Client CLI: import from GitHub, update, install — design

> **Historical design document.** Written while the project was a private tool for one team, before it was open-sourced; "the owner" is the original author. Statements of scope (e.g. open source as a non-goal) and deployment details reflect that time. Current behaviour is described in the README and `docs/adr/`.

Date: 2026-10-29
Status: draft for review
Based on: `docs/superpowers/specs/2026-10-28-skills-service-design.md` (hereafter "the main spec"), `docs/superpowers/specs/2026-10-29-skill-folders-design.md` (hereafter "the folders spec").

## 1. Why

The owner finds good public skills (for example, `anthropics/skills` → `frontend-design`, `mcp-builder`) and wants to bring them into the registry so the whole team can see and find them over MCP. Today this is manual work in the UI editor: create the skill, upload files one by one, recreate the `reference/` and `scripts/` subfolders. When the author updates the skill in their repository, all of it has to be repeated.

Second, colleagues use different agents (Claude Code, Cursor, Codex, Gemini CLI and others). They need the skill on disk, not only over MCP: that is how scripts from `scripts/` and binary files work, and how clients without our MCP see the skill.

The model is `npx skills` (vercel-labs/skills): an npm package, `add`/`update`/`remove` commands, installation into a shared `.agents/skills/` folder and symlinks into agent folders. The difference: our source and target is our own registry with a token.

**What this changes in the main spec.** Two of its non-goals are dropped by the owner's decision:
- "Searching for and importing skills from the internet (GitHub…)" → import from GitHub on an explicit human command (no search).
- "Delivering skill files to the agent's disk" → the `install` command.

The main spec's trust model ("a human reviews every skill before publishing") is preserved as follows: import and update are started by a human with an explicit command and their own token, and that human is responsible for the content. The version author in history and audit is the token owner. `--dry-run` lets you see what will arrive before anything is written.

The previously removed import (commit `ea689da`: zip/folder via the UI, `POST /api/import`, `cli.js import`) is not coming back. The new import runs on the client and uses the regular `POST /api/skills` / `PUT /api/skills/:slug`.

## 2. Goals

1. A separate npm package with a CLI that is installed on the user's machine and talks to the server over HTTP with an `sk_…` token.
2. `import`: bring a skill from a public GitHub repository into the registry with all its files and subfolders, recording where it came from.
3. `update`: pull a new version from the same source, verifying that the skill in the registry really came from there; edits made in the registry after import are overwritten with a warning.
4. `install`/`uninstall`: put a skill from the registry on disk for any agent — into the project by default, globally with `-g`.
5. Everything that changes the registry supports `--dry-run`.

## 3. Non-goals

- GitLab, Azure, arbitrary git hosts, direct archive links. GitHub only; the host is stored in the source so others can be added later.
- Searching public catalogs (skills.sh, GitHub search) from the CLI. The user specifies the source.
- Automatic scheduled sync. A human runs `update`.
- Merging team edits with upstream. `update` overwrites (with a warning); version history allows going back.
- Import through the UI or MCP. Publishing over MCP remains a non-goal of the main spec.
- The well-known protocol (`/.well-known/agent-skills/`) for `npx skills`: it fetches anonymously, while the registry is gated by tokens. May be revisited later.
- A project lock file and `install` of all skills from it (like `skills experimental_install`). Can be added later: the metadata file in the skill folder (§7.3) allows for it.
- Managing tokens, users and folders from the CLI (except creating a folder during import).

## 4. Anti-goals

- `update` silently overwrites a skill that was not imported from this source (created manually or imported from another repository/path).
- `import` silently puts a skill into someone else's existing folder or overwrites an existing skill.
- The token leaks: into logs, command output, git (metadata files in the project), or URLs.
- The CLI creates files outside the target folder (path traversal from names in the GitHub archive or from manifest paths), or `uninstall` deletes something it did not install.
- Weakened UI protection: Bearer access to REST must not open CSRF for browser sessions.

## 5. Owner's decisions

1. A separate client command (not well-known for `npx skills`).
2. Import from public repositories, modeled on `npx skills add anthropics/skills --skill frontend-design`.
3. Folder: given with `--folder`; if omitted, a new folder is created with a slug equal to the skill's slug (`frontend-design`). If a folder with that slug already exists (including an archived one), a conflict error is raised and nothing is created.
4. A skill with that slug already exists in the registry → conflict error.
5. The `update` command must verify, using the source metadata, that the skill in the registry is exactly this skill from this source.
6. On `update`, if the registry has edits since the last import/update: upstream wins, the edits are overwritten, and the user gets a conflict warning.
7. `--dry-run` for import and update.
8. Distribution: an npm package, run via `npx <package> …` or a global install. Name: `@isqanderm/skills-registry`, binary `skills-registry`; no need to publish yet.
9. `install` — into the current project by default, `-g` for global.
10. Any agents (the team uses different clients).

## 6. Server

### 6.1 Bearer token for REST

Currently `/api/*` accepts only a cookie session (`requireSession`), and mutating requests are checked by `Origin` (`platform/http/security.ts`). The CLI needs access via `Authorization: Bearer sk_…`.

- `/api/*` accepts **either** a session **or** a Bearer token. Token verification is the same as for MCP (Identity: hash, revocation, `lastUsedAt`, rate limit on failed checks per IP).
- The `Origin` check is skipped only for a request authenticated with a Bearer token. If both a cookie and `Authorization` arrive, the request is rejected (`400`) to avoid ambiguity about whose principal it is.
- Bearer does not grant access to `/api/tokens` and `/api/users` (403): a token cannot create tokens or manage users. Available: `/api/skills/**`, `/api/folders/**`, `GET /api/auth/me` (or an equivalent for verifying the token in `login`).
- The decision is recorded in ADR `0008`.

### 6.2 Skill source

A new domain concept, **Source** — where a skill was imported from:

- at the skill level: `host` (`github.com`), `repo` (`owner/name`), `path` (path of the skill folder inside the repository), `ref` (what the user requested: branch/tag, or `null` = default branch), `syncedVersion` (number of the registry version created by the last import/update);
- at the version level: `sourceCommit` (SHA of the commit the files were taken from) — on versions created by `import`/`update`; `null` on the rest.

Storage: the `catalog` schema (a new migration), for example `catalog.skill_sources` + a `source_commit` column in `catalog.skill_versions`. The table shape is up to the implementer.

API:
- `POST /api/skills` (multipart) accepts optional source fields; the skill is created together with its Source in one transaction.
- `PUT /api/skills/:slug` accepts an optional `sourceCommit`; if it is passed, the server requires the skill to have a Source and updates `syncedVersion` after publishing. Publishing without `sourceCommit` (from the UI) does not touch the Source — this is how the server and CLI detect "edits after import".
- `GET /api/skills/:slug` returns `source` (or `null`) and `sourceCommit` on versions.
- The source comparison (`update` with an explicit source) is done by the CLI using `source` from the response; the server stores and returns it.

UI: on the skill page — a line "Imported from `owner/repo/path` @ `<sha7>`" with a link to GitHub (only `https://github.com/...`, built from the fields, not from an arbitrary URL). In version history — a marker on versions with `sourceCommit`. Strings go in `strings.ts`.

### 6.3 What does not change

Limits (`MAX_FILES_PER_SKILL` 500, `MAX_FILE_BYTES` 1 MB, `MAX_SKILL_BYTES` 10 MB), path rules (`FilePath`), the "slug = `name` in frontmatter" invariant, CAS via `baseVersion`, outbox events and search reindexing — as they are now.

## 7. CLI

### 7.1 Package

- `packages/cli` in the monorepo. Package `@isqanderm/skills-registry` (the name `skills-registry` is taken on npm), binary `skills-registry`. The package is ready to publish (`bin`, `files`, build), but publishing to npm and a CI job are out of scope for this work: for now it runs from the repository (`pnpm --filter @isqanderm/skills-registry …` or `npm link`). Node ≥ 22.
- Talks to the server only over REST and validates responses with `@skills/contracts` schemas. `@skills/contracts` is not published: the CLI is built into a single file (`vp pack`), and the contracts end up in the bundle.
- Does not import `apps/server` or `apps/web` (a dependency-cruiser rule analogous to `web-no-server`).
- Output: human-readable on stdout, errors and warnings on stderr. Exit codes as in the server CLI: 0 — success, 1 — the operation failed (including a conflict), 2 — invalid invocation.

### 7.2 Connecting

- `login <url>`: reads the token from stdin (without echo if a TTY), verifies it with a request to the server, saves `{ url, token }` to `~/.config/skills-registry/config.json` (honoring `XDG_CONFIG_HOME`), permissions `0600`, directory `0700`.
- `logout`: deletes the config.
- The environment variables `SKILLS_REGISTRY_URL` and `SKILLS_REGISTRY_TOKEN` take precedence over the config (for CI).
- The token is never printed or logged; error messages show only the `sk_…` prefix and the last 4 characters, if anything at all.

### 7.3 Commands

```
skills-registry login <url>
skills-registry logout
skills-registry list [--folder <slug>]
skills-registry search <query> [--folder <slug>]
skills-registry import <source> [--skill <name>]... [--folder <slug>] [--ref <ref>] [--dry-run]
skills-registry update <slug> [<source>] [--dry-run]
skills-registry install <slug>[@<version>]... [-g] [-a <agent>]... [--copy] [--dir <path>] [--force]
skills-registry uninstall <slug>... [-g] [-a <agent>]... [--dir <path>]
```

#### `import`

Source:
- `owner/repo` — then `--skill <name>` is required (may be repeated);
- `https://github.com/owner/repo/tree/<ref>/<path>` — the path to the skill folder;
- `--ref` — branch/tag/commit; defaults to the repository's default branch.

Steps:
1. Resolve the commit SHA for the ref (GitHub API) and download that commit's tarball (`codeload`/`/tarball/<sha>`). `git` is not needed. If `GITHUB_TOKEN` is set, use it (rate limits, private repos); otherwise anonymous.
2. Extract as a stream, with protection: regular files only (symlinks, hard links and everything else are skipped and listed in the output), paths go through the same logic as `FilePath` (no `..`, absolute paths, NUL). The tarball contains the whole repository (`anthropics/skills` has dozens of skills), so limits are split: the archive as a whole has a separate, large download limit (around 200 MB of compressed stream, overridable via an environment variable); only `SKILL.md` files (for lookup) and the files of the selected folder are kept in memory, the rest is discarded on the fly. Registry limits (500 files, 1 MB, 10 MB) apply to the files of the selected folder.
3. Find the skill by `--skill`: the folder whose `SKILL.md` has `name` = the value; lookup as in `npx skills` (root, `skills/*`, etc. — the order is up to the implementer, but deterministic). For a URL with a path — exactly that folder.
4. Skill files — all files of the folder, recursively, with paths relative to it. Check the registry limits on the client and give a clear error before sending.
5. Slug = `name` from frontmatter. If a skill with this slug already exists (active or archived) — conflict error.
6. Folder: if `--folder` is given, it must exist and be active, otherwise an error. If not given, a folder is created with slug = the skill's slug; folder name = `name`, description = `description` from frontmatter (truncated to the folder limit). If a folder with that slug already exists (including an archived one) — conflict error with a `--folder` hint.
7. Create (the folder, then the skill with its Source and `sourceCommit`). Version message: `import from <owner>/<repo>/<path>@<sha7>`.
8. `--dry-run`: steps 1–6 run (including conflict checks via GET), nothing is created; the output shows what would be created: slug, folder (new/existing), list of files with sizes, skipped files.

If an error happens after the folder is created but before the skill is created, the CLI reports that the folder was left empty and how to archive it; it does not attempt a rollback.

Multiple `--skill` flags are processed one by one; each is independent, and the result is a "created / conflict / error" summary with exit code 1 if at least one was not created.

#### `update`

1. `GET /api/skills/:slug`. No skill — error. No `source` — error "skill was not created by import, nothing to update from". Skill is archived — error.
2. If `<source>` is passed, it must match `source` (host, repo, path; ref — if given), otherwise an error and nothing changes.
3. Resolve the commit for `source.ref` and compare it with the `sourceCommit` of version `syncedVersion` (`GET /api/skills/:slug?version=<syncedVersion>`). If it matches, upstream has not changed: the tarball is not downloaded, nothing is published (with `--dry-run` too), output `<slug> is up to date (<source>@<sha7>)`; if the current version ≠ `syncedVersion` — an extra line `  registry changes since v<synced> are kept (v<current>)` (registry edits are left alone); exit 0. Otherwise download that commit (as in `import`, steps 1–4). Check that `name` in `SKILL.md` still equals the slug; if not — an error (renaming a skill upstream is not supported).
4. If the commit is new, compare the upstream files with the current registry version by path and sha256. If they match — "already up to date", exit 0, no new version is created (and `syncedVersion` is not touched). Registry edits are overwritten (steps 5–6) only when a new commit has appeared upstream.
5. A conflict is determined **by content, not by number**: the manifest of the current version (paths + sha256) ≠ the manifest of version `syncedVersion`. This way a UI rollback to the synced content (new number, same files) is not treated as a conflict. On conflict, print a warning to stderr: which versions after `syncedVersion` will be overwritten (numbers, authors), which files differ from the synced version, how to get them back (rollback to a version in the UI). Then continue. For this, `GET /api/skills/:slug` (with `?version=`) returns sha256 for files — it is not in `files` today, add it.
6. `PUT /api/skills/:slug` with the full set of files, `baseVersion` = current, `sourceCommit`, message `update from <owner>/<repo>/<path>@<sha7>`. A CAS error (someone saved between steps 1 and 6) — report it and suggest running again.
7. Output: old → new version, added/changed/removed files.
8. `--dry-run`: steps 1–5, without writing; the output is the same as what would be done, including the conflict warning.

#### `install` / `uninstall`

Layout as in `npx skills`:
- Canonical copy: in a project `./.agents/skills/<slug>/`, with `-g` — `~/.agents/skills/<slug>/`. "Project" means the current directory (no search for a git root).
- For each selected agent whose skills folder differs from the canonical one — a symlink `<agent folder>/<slug>` → the canonical copy. With `--copy` — an independent copy instead of a symlink. On Windows, if a symlink cannot be created — a copy with a warning.
- Agents: `-a` (repeatable). Without `-a` — all detected agents (by the presence of their home directory, e.g. `~/.claude`, `~/.cursor`, `~/.codex`); if none is found — only the canonical copy. `-a '*'` — all known agents.
- Known agents are a table in the CLI (id, project path, global path), cross-checked against `vercel-labs/skills` `docs/agents.md`. Minimum set: `claude-code`, `codex`, `cursor`, `gemini-cli`, `github-copilot`, `opencode`, `cline`, `windsurf`, `goose`, `amp`. Extending means adding a row to the table.
- `--dir <path>` — install only into this folder (as the canonical one), without agents.

Content:
- All version files are downloaded via `GET /api/skills/:slug/files/<path>?version=N` (including binary ones), written to a temporary folder next to the target, and atomically renamed into the target. Paths are checked again (must not escape the skill folder).
- A metadata file `.skills-registry.json` in the canonical copy: `{ server, slug, version, files: { path: sha256 } }`. It contains no token.
- `<slug>@<version>` — a specific version; without a version — the latest.

Repeated `install`:
- no folder — installed;
- exists, with a `.skills-registry.json` for the same server and slug, and files on disk match the recorded hashes — updated to the requested version (if it is the same version — "already installed");
- exists, but without the metadata file, with a different server/slug, or files edited by hand — conflict error; `--force` overwrites;
- the agent's symlink already points to the canonical copy — nothing; to something else — conflict, `--force` replaces it.

`uninstall`: removes the symlinks/copies for the selected agents (only if it is our symlink to the canonical copy or a copy with our metadata file) and the canonical copy. It does not touch anything else and reports it.

## 8. Security

- Bearer for REST — §6.1; tests: Bearer without a cookie passes without `Origin`, a cookie without `Origin` still gets `csrf`, cookie + Bearer — 400, Bearer on `/api/tokens`/`/api/users` — 403, revoked token — 401.
- Tarball extraction: regular files only, path checks, limits — as in `import`, step 2 (a large limit for the archive, registry limits for the skill folder), rejection of archives with paths outside the root.
- Writing to disk in `install`: every path is normalized and checked to be inside the target folder; no symlinks are created inside a skill (the registry does not store them anyway).
- The config with the token is `0600`; `.skills-registry.json` has no secrets.
- Content from GitHub is untrusted: the UI already renders Markdown with sanitization; the source link in the UI is built from validated fields (`owner`/`repo` matching `[A-Za-z0-9._-]+`).
- Audit: import and update are logged as skill creation/version publication with the token owner's principal.

## 9. Verification

- Domain: Source (field validation), the rule "publishing with `sourceCommit` requires a Source".
- Application: creating a skill with a Source; publishing with `sourceCommit` updates `syncedVersion`, publishing without it does not.
- Integration (Testcontainers): Bearer on REST (§8), creation with a Source, `GET` returns `source`/`sourceCommit`.
- CLI unit (no network, HTTP and filesystem fakes or temporary directories): source parsing, finding a skill in the extracted tree, extraction protection, the "up to date / conflict / update" decision, `install`/`uninstall` layout, repeated `install`.
- CLI against a real server: an e2e scenario in the existing infrastructure (image + Playwright or a separate script) — `login` → `import` from a local fake "GitHub" (a stub HTTP server serving a tarball, so CI does not hit the internet) → an edit in the UI/API → `update` with a warning → `install -a claude-code` into a temporary directory.
- `pnpm verify` is green; dependency-cruiser rules for the new package.

## 10. Later

- Publishing to npm (public or private registry), a CI job, CLI/server version compatibility.

## 11. Left to the implementer

- The shape of the source tables and field names in the contracts.
- The argument-parsing library (target: `node:util` `parseArgs`, as in the server CLI) and the tar extraction library (no native dependencies).
- The order in which a skill is looked up inside a repository.
- The exact set of agents beyond the minimum, and the output format.
- How exactly the CLI gets the GitHub API address (a variable for overriding it in tests).
