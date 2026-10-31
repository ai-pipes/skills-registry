# Subagents — design

Date: 2026-10-31
Status: draft for review
Based on: `docs/superpowers/specs/2026-10-28-skills-service-design.md` (hereafter "the main spec"), `docs/superpowers/specs/2026-10-29-skill-folders-design.md` (hereafter "the folders spec"), `docs/superpowers/specs/2026-10-29-client-cli-design.md` (hereafter "the CLI spec").

## 1. Why

The owner wants to build any project with a team of role-specific agents: a DevOps engineer, a developer, a tester, a reviewer and so on, orchestrated by a main session. In Claude Code such a role is a **subagent**: a markdown file in `.claude/agents/` with a role prompt, a tool whitelist and a model. Today these files are written by hand and copied between projects, and the knowledge each role needs (a release runbook, Docker conventions) is duplicated inside the prompts.

The registry already stores, versions and serves skills. Subagents are the same kind of artifact: a markdown file with frontmatter. Storing them in the registry gives versions, history, search, folders and installation through the same CLI.

**The split between the two.** A subagent and a skill change at different rates and carry different risk:

| | Subagent | Skill |
|---|---|---|
| Holds | Role, permissions (`tools`), model | Procedures, conventions, knowledge |
| Changes | Rarely | Often |
| Risk | High: defines what the agent *can* do | Lower: steers behaviour within those permissions |
| Reaches the machine | Installed as a file by the CLI, updated by an explicit command | Loaded at run time over MCP (`get_skill`), always the latest version |

The permissions are pinned on the user's disk and change only with an explicit `update`. A bad skill in the registry can steer an agent, but cannot widen its tool list. A skill fixed in the registry reaches every installed subagent on its next run, with nothing to reinstall.

## 2. Goals

1. A subagent is a new registry entity: created, edited, versioned, archived, restored, moved between folders and rolled back through the web UI, as skills are.
2. A subagent lists the registry skills it needs. When it runs, it loads them over MCP.
3. The CLI installs, updates and uninstalls subagents for Claude Code, one by one, several at once, or a whole folder, into the project or globally, and lists what is available and what is installed.
4. An update that changes a subagent's `tools` is never applied silently.

## 3. Non-goals

- **Teams** (a set of subagents plus an orchestrator with stages). A later step; folders give grouping in v1.
- Importing subagents from GitHub.
- Loading subagents at run time over MCP (a `get_subagent` tool), and exposing subagents in `search_skills`.
- Install targets other than `claude-code` (OpenCode and others have their own formats).
- Pinning a skill version inside a subagent. A subagent always loads the latest version of each skill.
- Protecting the link between a subagent and its skills: archiving a skill that subagents reference is allowed and needs no special handling. Keeping references valid is the admins' responsibility.
- Extra files in a subagent. A subagent is one file; anything longer than a prompt belongs in a skill.
- Separate publishing permissions for subagents.

## 4. Anti-goals

- An update widens or changes a subagent's `tools` on the user's machine without the user seeing it.
- The CLI writes a subagent file whose frontmatter is not what the registry stored (YAML injection through `description` or the prompt), or writes outside `.claude/agents/`.
- `uninstall` removes a subagent file the CLI did not install (written by hand).
- Subagents leak into skill search over MCP: an agent calling `search_skills` gets subagents back.
- The word "agent" means two things: in the CLI, API and UI the new entity is always called **subagent**.

## 5. Owner's decisions

| Question | Decision |
|---|---|
| Name of the entity | `subagent` |
| CLI flag convention | Keep the `vercel-labs/skills` convention: `-a/--agent` is the coding agent target (`claude-code`, …), as today |
| CLI shape | Subagent commands in their own group: `skills-registry subagent <command>`; skill commands stay as they are |
| How skills reach a subagent | Dynamically over MCP, always the latest version, no pinning |
| Archiving a referenced skill | No special handling: the admins' responsibility |
| Who may publish subagents | The same users as for skills (any `member` or `admin`) |
| Update that changes `tools` | Show the diff; the subagent is skipped and the command exits 1 unless `--yes` |
| v1 scope | UI CRUD with versions, history, diff; CLI install/uninstall/list by slug or folder, update, installed listing; target `claude-code` only |
| Out of v1 | Teams, GitHub import, MCP on-the-fly loading, other targets |

## 6. The `SUBAGENT.md` format

A subagent version is one UTF-8 text file, `SUBAGENT.md`:

```markdown
---
name: devops
description: Use for Dockerfiles, CI workflows, deploys, infra config. Not for app code.
tools: [Bash, Read, Edit, Grep, Glob, mcp__github__create_pull_request]
model: sonnet
skills: [release-runbook, docker-conventions]
---
You are the DevOps engineer on this project.
Scope: Dockerfile, docker-compose, .github/workflows, deploy scripts.
...
```

Rules:

- `name` — required, equals the slug (the same invariant as `SKILL.md`).
- `description` — required, non-empty, at most 1024 characters (as for skills). It tells the main session when to delegate to this subagent.
- `tools` — optional YAML list of strings. Omitted means "inherit every tool" (Claude Code semantics). Each entry is a built-in tool name (`^[A-Z][A-Za-z0-9]*$`) or an exact MCP tool name (`^mcp__[A-Za-z0-9_-]+__[A-Za-z0-9_-]+$`). No duplicates. *My calls: a pattern, not a fixed list of built-in tools, so a tool Claude Code adds later does not need a registry release. No wildcard MCP entries (`mcp__github__*`): it is not verified that Claude Code honours them in a subagent's `tools`, and an entry it ignores would silently leave the installed subagent with fewer tools than the registry shows. An empty list `[]` is rejected: rendered for Claude Code it could read as "inherit all", the opposite of what it says.*
- `model` — optional: `sonnet`, `opus`, `haiku` or `inherit`. Omitted means `inherit`.
- `skills` — optional YAML list of skill slugs, no duplicates, at most 20. On create and publish every slug must be an existing **active** skill (error `unknown_skill` naming the slug). Afterwards nothing is enforced (§3): rollback and restore do not re-check, because they bring back a version as it was. *My call, consistent with the owner's "archiving a referenced skill needs no handling".*
- Any other frontmatter key is rejected (error `invalid_frontmatter`). *My call: the installed file is generated from these fields, so an unknown key would be silently dropped on install; rejecting it is clearer.*
- The body is the role prompt, may be empty, and is stored as written.
- Size: the whole file is at most 64 KB. *My call: a prompt this long is already a sign it should be a skill.*

Parsing reuses the approach of `domain/skill-md.ts` (the `yaml` package, the same frontmatter regex and error positions).

## 7. Model (Catalog module)

### Subagent — a new aggregate in `catalog`

Mirrors `Skill`, without the source:

- `id`, `slug` (the same `Slug` rules; the namespace is separate from skills and folders, so a skill `devops` and a subagent `devops` can coexist; the slug `new` is reserved for the UI route), `folderId` (required), `status` (`active` | `archived`), `updatedAt`;
- the latest `SubagentVersion`: `number`, `name`, `description`, `tools: string[] | null`, `model`, `skills: string[]`, `contentSha256` (the `SUBAGENT.md` blob in the existing `BlobStore`), `authorId`, `message`, `createdAt`, `restoredFrom`.

Versions are immutable. Publishing uses compare-and-set on `baseVersion`, rollback creates a new version with `restoredFrom`, as for skills.

### Rules shared with skills and folders

The folders spec rules apply to subagents unchanged:

1. A subagent lives in exactly one folder; creating in or moving to an archived folder is forbidden.
2. Archiving a folder archives its active subagents in the same transaction as its skills (`catalog.subagent_archived` for each, audit `subagent.archive` with `meta.viaFolder`).
3. Restoring a folder does not restore subagents; restoring a subagent whose folder is archived is forbidden (`folder_archived`); "restore into folder X" exists for subagents too.
4. Publish and rollback are forbidden for an archived subagent.
5. The folder-status race is handled as for skills (row lock on the folder).

`list_folders` over MCP keeps counting skills only.

### Events

`catalog.subagent_version_created`, `catalog.subagent_archived`, `catalog.subagent_restored`, `catalog.subagent_moved`, payload `{ subagentId, slug }` (plus `version` / `folder` as for skills). Search subscribes to them (§9).

### Audit

`subagent.create`, `subagent.publish`, `subagent.rollback`, `subagent.archive`, `subagent.restore`, `subagent.move`, with the same principal handling as skills.

### Database

A new migration (`0011_catalog_subagents.sql` or the next free number): `catalog.subagents` and `catalog.subagent_versions`, with `folder_id` referencing `catalog.folders`. The table shape is left to the builder, following the skills tables.

## 8. REST API and contracts

`/api/subagents`, accessible with a session or a Bearer token exactly like `/api/skills` (ADR 0008). Contracts in `packages/contracts/src/subagents.ts`.

| Method | Path | What |
|---|---|---|
| GET | `/api/subagents?status=&folder=&q=` | List; with `q`, ordered by search (§9) |
| POST | `/api/subagents` | Create: JSON `{ slug, folder, content, message? }` |
| GET | `/api/subagents/:slug?version=N` | Summary + the version: parsed fields and `content` |
| PUT | `/api/subagents/:slug` | Publish: `{ content, baseVersion, message? }` |
| GET | `/api/subagents/:slug/history` | Versions with author logins |
| GET | `/api/subagents/:slug/diff?from=&to=` | Text diff of `SUBAGENT.md` plus `tools` before/after |
| POST | `/api/subagents/:slug/rollback` | `{ version, baseVersion }` |
| POST | `/api/subagents/:slug/archive`, `/restore`, `/move` | As for skills |

JSON instead of multipart because a subagent is one text file. *My call.*

`GET /api/skills/:slug` gains `usedBy: string[]` — slugs of active subagents whose latest version lists the skill. *My call: cheap within Catalog, and it is what an admin needs before archiving a skill.*

## 9. Search

Subagents are searched in the UI with the same hybrid search as skills (FTS + embeddings, ADR 0004/0005).

- `search.documents` gains `kind` (`skill` | `subagent`), and the key becomes `(kind, slug)`. Existing rows get `skill` in the migration.
- The indexed passage for a subagent is `name`, `description` and the body.
- `search_skills` over MCP and `GET /api/skills?q=` filter on `kind = 'skill'` **before** the top-50 selection (the same reasoning as the folder filter in the folders spec §7). Subagents never appear in MCP results.
- Search reads subagents through Catalog's public `index.ts`, as it reads skills.

## 10. Web UI

A new **Subagents** section in the navigation, next to Skills, with the same pages: list (folder filter, search, status), view, editor (new/edit), history, diff.

**Editor.** A form with a **Form | Raw** switch; both edit the same `SUBAGENT.md`, and switching converts losslessly (the Raw tab uses the existing `CodeEditor`):

- Slug, Description (hint: "when to call it, not who it is"), Folder;
- Model — a select (`inherit`, `sonnet`, `opus`, `haiku`);
- Tools — checkboxes for common built-in tools (`Read`, `Grep`, `Glob`, `Edit`, `Write`, `Bash`, `WebFetch`, `WebSearch`), a free-entry list for other built-ins and MCP tools, and an "Inherit all tools" toggle for an omitted `tools`; with the toggle off, at least one tool must be selected (§6);
- Skills — a picker with autocomplete over active skills; the selected skills are chips;
- Prompt — a text area;
- Message and Publish, with the same unsaved-changes guard as the skill editor.

Validation errors from the server go under the matching field (`unknown_skill` under Skills, a bad tool name under Tools).

**View page.** Description, model, tools, the skills as links to their pages, the prompt rendered as sanitized Markdown (the same `react-markdown` + `rehype-sanitize` setup as skills), and a "Copy install command" field (`CopyField`) with `skills-registry subagent install <slug>`.

**History and diff.** As for skills. When `tools` differ between the two versions, the diff page shows a highlighted "Permissions changed" block with the added and removed tools above the text diff.

**Skill page.** A "Used by" line listing the subagents from `usedBy`.

All strings go in `strings.ts`. CSP rules, Base UI, no Radix — as for the rest of the UI.

## 11. CLI

### 11.1 Commands

```
skills-registry subagent list [--folder <slug>] [--installed] [-g]
skills-registry subagent install <slug>... [--folder <slug>] [-g] [-a claude-code] [--mcp-server <name>] [--force]
skills-registry subagent update [<slug>...] [-g] [--yes]
skills-registry subagent uninstall <slug>... [--folder <slug>] [-g] [-a claude-code]
```

Skill commands (`list`, `search`, `import`, `update`, `install`, `uninstall`) do not change. The top-level `update` keeps its meaning from the CLI spec (pull an imported skill from GitHub into the registry), which is why updating installed subagents lives in `subagent update`.

- **`-a/--agent`** — the coding agent target, as for skills. The only accepted value in v1 is `claude-code`; any other known agent id gives `error: <id> does not support subagents (supported: claude-code)`, exit 2. Without `-a`: `claude-code` if `~/.claude` exists, otherwise an error asking for `-a claude-code`.
- **`-g`** — global (`~/.claude/agents/`); without it, the project (`./.claude/agents/`, the current directory as in the CLI spec).
- **`--folder <slug>`** — on `install`, every active subagent of the folder; on `uninstall`, every installed subagent that the registry lists in that folder. It can be combined with explicit slugs.
- **`--mcp-server <name>`** — the name under which the user connected the registry's MCP server in Claude Code; default `skills` (the name used by the `claude mcp add` command the server prints, `identity/interfaces/http/tokens.ts`). It is recorded in the marker (§11.3) and reused by `update`.

### 11.2 The installed file

The CLI renders `.claude/agents/<slug>.md` from the registry's parsed fields. The server knows nothing about Claude Code's file format.

- Frontmatter: `name`, `description`, `tools` as Claude Code expects it (a comma-separated string), `model` (omitted when `inherit`). It is produced with the `yaml` library, never by string concatenation (anti-goal: YAML injection). The CLI checks `tools` and `model` against the same patterns as the server before writing.
- When `skills` is non-empty:
  - if `tools` is set, `mcp__<server>__get_skill` and `mcp__<server>__search_skills` are appended to it (no duplicates);
  - a generated block goes before the body, along the lines of:

    > Before starting, load each of these skills with the `get_skill` tool of the `<server>` MCP server and follow them: `release-runbook`, `docker-conventions`. If a skill cannot be loaded, stop and report it instead of improvising.

  The final wording is the builder's; it must name the skills explicitly and must tell the agent to stop when a skill cannot be loaded.
- Then the body as stored.

### 11.3 Ownership marker

The CLI records each install so that `update`, `uninstall` and `list --installed` work only on its own files. One JSON manifest per agents directory, `.claude/agents/.skills-registry.json`: `{ subagents: { <slug>: { server, version, sha256, mcpServer } } }`, where `sha256` is the hash of the rendered file. No token. *My call: a single file next to the subagents rather than one marker per subagent; the builder may choose a different layout if it keeps these guarantees.*

A file is **ours** when the manifest has an entry for its slug from the same server and the file's current sha256 equals the recorded one. Otherwise it is **foreign** (written or edited by hand).

### 11.4 Behaviour

**`install`**
- No file → write it (temporary file + rename), record it.
- Ours, same version → `already installed`. Ours, older version → behaves like `update` for that slug, including the `tools` gate (§11.5).
- Foreign → conflict error, `--force` overwrites (and records it).
- Prints, per subagent: version, model, tools (or "all tools"), skills. The user sees the permissions on first install.
- Several slugs and `--folder` are processed one by one; the result is a summary, exit 1 if any failed.

**`update`**
- Without slugs: every subagent recorded in the manifest of the chosen scope.
- For each: fetch the latest version. Same version → `up to date`. Foreign file → skip with a conflict message (no `--force` here: reinstall with `install --force`). A newer version whose `tools` equal the installed ones → rewrite. A newer version with different `tools` → §11.5.

**`uninstall`** — removes ours, skips and reports foreign, removes the manifest entry. Exit 1 if anything was skipped, as for skills.

**`list`**
- Without `--installed`: active subagents in the registry, one per line: `<slug>\tv<version>\t<folder>\t<description>`, like `list` for skills.
- With `--installed`: the manifest of the chosen scope merged with the registry: `<slug>`, installed version, latest version (marked when newer), state (`ok`, `modified` for a foreign file, `archived`, `missing` when the registry no longer has it).

### 11.5 The `tools` gate

When the new version's `tools` differ from the installed ones (including a change between "set" and "inherit all"):

- print to stderr the slug and the added and removed tools;
- without `--yes`: leave the file as it is, continue with the other subagents, and exit 1 at the end;
- with `--yes`: apply.

Changes in `model`, `skills`, `description` or the prompt do not trigger the gate; the output lists what changed.

## 12. Security

- A subagent is executable configuration: whoever installs one with `Bash` runs what its prompt asks for. The trust model of the main spec applies: a person publishes it with their own account, and the history and audit record who. The installing user sees the permissions on install (§11.4) and on every change of them (§11.5).
- Dynamically loaded skills are untrusted text for the agent, as today; they cannot change the installed `tools`.
- The prompt is rendered in the UI only through the sanitized Markdown pipeline.
- The CLI never writes outside `.claude/agents/` of the chosen scope, writes through a temporary file and rename, and refuses a slug that is not a valid `Slug` (no path tricks).
- Frontmatter of the installed file is generated, not copied (§11.2).

## 13. Documentation

- A new ADR `0010-subagents.md`: why subagents are a separate aggregate, why skills are loaded dynamically and permissions installed statically, and why the CLI keeps the `-a` convention.
- `CLAUDE.md`: add **Subagent** and **SubagentVersion** to the domain glossary, `catalog.subagents*` to the schema list.
- `README.md`: the new section in the UI and the `subagent` commands.

## 14. Verification

- Domain: `SUBAGENT.md` parsing (required fields, `tools`/`model`/`skills` patterns, unknown keys, size), the `Subagent` aggregate (publish, CAS, rollback, archive/restore, move), the folder cascade including subagents.
- Application with fake ports: create/publish with an unknown or archived skill → `unknown_skill`; `usedBy`; events and audit.
- Integration (Testcontainers): the `/api/subagents` routes with a session and with Bearer; folder archive cascade; the folder race; search returns subagents for `/api/subagents?q=` and never for `search_skills` / `/api/skills?q=`.
- Web: editor Form ↔ Raw round trip, field errors, the "Permissions changed" block, "Used by" on the skill page.
- CLI unit (fake env): rendering (YAML-hostile description and prompt, `tools` set / omitted, MCP tools appended, custom `--mcp-server`), ownership (ours / foreign / edited), install by slug and by folder, update with and without `--yes`, `list --installed` states, unsupported `-a`.
- CLI against a real server: extend the existing e2e scenario with `subagent install` → publish a version with changed `tools` in the API → `subagent update` exits 1 → `subagent update --yes` applies.
- `pnpm verify` green.

## 15. Later

- Teams: a set of subagents plus an orchestrator skill with stages, artifacts and gates; `skills-registry team install <slug>`.
- `get_subagent` over MCP for read-only roles loaded at run time.
- Other targets (OpenCode).
- Importing subagents from GitHub.

## 16. Left to the builder

- Table shapes, contract field names, the migration number.
- The exact wording of the generated skill-loading block (within §11.2).
- The marker layout, if a different one keeps the §11.3 guarantees.
- The common built-in tools shown as checkboxes in the editor.
- Output formatting of the CLI commands beyond what §11.4 fixes.
