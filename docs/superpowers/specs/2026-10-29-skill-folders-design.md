# Skill folders — design

> **Historical design document.** Written while the project was a private tool for one team, before it was open-sourced; "the owner" is the original author. Statements of scope (e.g. open source as a non-goal) and deployment details reflect that time. Current behaviour is described in the README and `docs/adr/`.

Date: 2026-10-29
Status: draft for review
Based on: `docs/superpowers/specs/2026-10-28-skills-service-design.md` (hereafter "the main spec").
Precondition: skill import (the UI page, `POST /api/import`, the CLI command `import`) was removed in a separate change before this work, by the owner's decision. Skills are created only through the editor.

## 1. Why

The owner works with Claude across different projects and tasks and currently has to tell the agent in words which skills to use: "in this project use these, leave the rest alone", "this task is about DevOps, use only the DevOps skills". `search_skills` searches the whole catalog, and the agent gets the best matches from everywhere, including ones that merely happen to share words.

We need a logical grouping of skills into folders: "Design", "Architecture", "DevOps", "Project X". A folder has a description that lets Claude work out from the task context which folders it needs, and search only in those.

**Principle: the registry stores and serves, but does not decide.** Which folder to use, and what takes priority (a project skill or a general one), is decided by the user and by Claude's prompt/instructions. The registry provides a map of folders and search with a folder filter.

## 2. Goals

1. Every skill lives in exactly one folder.
2. Claude can get the list of active folders with descriptions and search for skills only in the selected folders.
3. Folders are managed through the web UI: create, edit, archive, restore, move a skill between folders.
4. Token usage stays minimal: one short option is added to the two MCP tools, and the full skill list is never handed to the agent.

## 3. Non-goals

- Nested folders: folders are flat.
- One skill in several folders, shortcuts or tags. If a skill is needed in two folders, the user makes a copy with a different slug (for example, `docker-deploy` in "DevOps" and `project-x-deploy` in "Project X").
- Formal relationships between skills ("extends", "depends on"). If a project skill builds on a general one, this is written in the `SKILL.md` text ("first read `docker-deploy`"), and the agent calls `get_skill` itself.
- Selection and priority logic on the server: the registry does not decide which folder fits a task and does not rank project skills above general ones.
- Per-folder access control: folders are visible to all users, like skills (main spec, "fine-grained permissions" is a non-goal). Any user (`member` and `admin`) can create, change, archive and restore folders, just as with skills today: Catalog has no role checks.
- Managing folders over MCP: UI only, as for skills.
- The folder in a skill's version history: the folder is the skill's place in the catalog, not part of its content.

## 4. Anti-goals

- A skill with no folder or in two folders at once (invariant violated).
- The agent has to load the whole catalog to choose a folder.
- Moving, archiving or restoring a folder loses changes in the search index: for example, a skill from an archived folder can still be found.
- Archiving a folder leaves its skills active, or restoring a folder silently brings back skills that were archived individually.

## 5. Owner's decisions

| Question | Decision |
|---|---|
| Structure | Folders are flat, no nesting |
| Membership | A skill lives in exactly one folder; skills outside folders do not exist |
| Needed in two places | The user duplicates the skill (new slug) |
| Relationships between skills | Not doing it |
| Management | Web UI only |
| Visibility | Folders are not hidden, visible to everyone |
| Archiving a folder | The folder goes to the archive, and so do all its skills |
| Restoring a folder | Only the folder is restored; skills stay archived, each is restored explicitly |
| Existing skills | A migration creates a "General" folder and puts all existing skills there |
| Folder choice by the agent | Decided by Claude from context and by the user; the registry does not decide |

## 6. Model (Catalog module)

### Folder — a new aggregate in `catalog`

- `id` (uuid);
- `slug`: kebab-case, by the same rules as a skill's `Slug`, unique among folders. Does not change after creation. Folder and skill namespaces are independent: a folder `devops` and a skill `devops` can coexist;
- `name`: human-readable name, non-empty, can be changed;
- `description`: a description for people and the agent, can be changed. Required, because Claude chooses the folder by it;
- `status`: `active` | `archived`;
- `createdAt`, `updatedAt`.

Folders cannot be deleted, only archived, like skills. The slug `new` is reserved (UI route `/folders/new`), as it is for skills today.

### Skill

The `Skill` aggregate gets `folderId`, a required field. Creation (`createSkill`) requires a folder. The folder must be active.

### Rules

1. **Moving** a skill to another folder: the target folder is active, the skill is active. Moving does not create a skill version. The audit log gets `skill.move` with `from` and `to`.
2. **Archiving a folder**: in one transaction, the folder and all its active skills switch to `archived`. Each skill emits the regular `catalog.skill_archived` event, so Search removes them from the index via the existing path. The audit log gets `folder.archive` with the number of archived skills; for each skill — `skill.archive` with `meta.viaFolder`.
3. **Restoring a folder**: only the folder → `active`. Skills are not touched.
4. **Restoring a skill** whose folder is archived is forbidden (error `folder_archived`). The UI offers to restore the folder or to move the skill straight into an active folder. Hence a separate "restore into folder X" operation (restore + move in one transaction). *Implementer's decision: this way a skill is never active inside an archived folder.*
5. **Archiving a single skill** does not change the folder. An empty active folder is allowed.
6. A skill cannot be created in, or moved to, an archived folder.
7. Changes to a skill (publish, rollback) remain forbidden for an archived skill, as today. No separate folder status check is needed: the skills of an archived folder are archived themselves.

Checks spanning two aggregates (folder status when creating, moving and restoring a skill) live in `application` use cases. Cascading archiving is the `archiveFolder` use case, which loads the folder and its active skills and saves everything in one transaction together with the outbox. The skill repository must be able to save a batch of aggregates in one transaction (or the use case works through a unit of work — up to the implementer, in the spirit of ADR 0002/0003).

The race "a folder is being archived while a skill is being created in it or moved into it": the folder status check and the skill write must happen in one transaction with a row lock on the folder (`select … for update`) or an equivalent guarantee. The test for this is an integration test.

### Events

- `catalog.skill_moved { skillId, slug, folder }` (new) — Search updates the document's folder;
- `catalog.skill_version_created`, `skill_archived`, `skill_restored` — as today; the folder need not be added to the payload, Search reads it via `SkillReader`.
- Search does not need folder events (`folder_created`, etc.); there is no need to introduce them for audit either: audit is written directly, as for skills.

### Database schema (migration `0006_catalog_folders.sql`)

- `catalog.folders (id uuid pk, slug text unique not null, name text not null, description text not null, status text check (status in ('active','archived')), created_at, updated_at)`;
- the migration inserts a "General" folder (`slug = 'general'`, a description along the lines of "General skills without a specific topic"); the id is a fixed uuid in the migration text;
- `catalog.skills.folder_id uuid references catalog.folders(id)`: add it, fill it with the id of "General", then `not null`; an index on `folder_id`;
- `search.documents.folder text not null` (folder slug) + an index. Existing rows are filled with `'general'` in the same migration, so no reindex is required.

The "General" folder can be renamed and archived like any other: it is special only in that the migration creates it.

## 7. Search

- `SkillReader.get` also returns the folder slug (via Catalog's public `index.ts`; Catalog tables are not read).
- `indexSkill` writes `folder` to the document. On `skill_moved`, the same `indexSkill` is called: if the version has not changed, the implementer may skip recomputing the embedding and update only `folder`.
- `searchSkills` accepts an optional `folders: string[]`. If it is set, FTS and vector candidates are restricted to these folders (`where folder = any($1)`) **before** the top-50 selection, not by filtering afterwards: otherwise the relevant skills get pushed out of the candidates. The threshold τ and the scoring formula do not change (ADR 0005).
- `SearchHit` gets a `folder` field (slug).

Searching within a folder does not check whether it is active: an archived folder has no skills in the index, and the result is simply empty. Unknown folder slugs are checked by the MCP layer (section 8).

## 8. MCP

Today: `search_skills` and `get_skill`. The main spec, goal 4, requires "only the descriptions of two MCP tools".

**Implementer's decision: a third tool, `list_folders`.** The alternative — putting the folder list into the server `instructions` — is rejected: the client reads the instructions once on connect, and the list goes stale until reconnect. One short tool description is cheap, and the folder list is small compared with the skill list. The departure from goal 4 of the main spec is recorded in a new ADR `0007-skill-folders-mcp.md`, and in the main spec goal 4 and section 9 are updated with a reference to this document.

- **`list_folders()`** → `{ folders: [{ slug, name, description, skills: <number of active skills> }] }` — active folders only, sorted by `name`. `readOnlyHint: true`.
- **`search_skills(query, limit?, folders?: string[])`**: `folders` is optional, 1–20 slugs. Without it, the whole catalog is searched, as today. If any slug is not found among active folders, the tool returns the error `Unknown folder "x". Call list_folders.` and does not search. Each hit in the result has a `folder`.
- **`get_skill`**: the response without `path` gains `folder` (slug).
- **Server instructions** gain one sentence, roughly: "Skills are grouped into folders by topic or project. If the task clearly belongs to some of them, call list_folders and pass their slugs to search_skills; otherwise search everything." The final wording is up to the implementer: it must not force a folder choice and must not require `list_folders` on every task.

Tool descriptions are in English, as today.

## 9. REST (`packages/contracts`, `catalog/interfaces/http`)

- `GET /api/folders?status=active|archived|all` → a list of `{ slug, name, description, status, skills: { active, archived } }`;
- `POST /api/folders` `{ slug, name, description }`;
- `PUT /api/folders/:slug` `{ name, description }`;
- `POST /api/folders/:slug/archive` → `{ archivedSkills: n }`; `POST /api/folders/:slug/restore`;
- `GET /api/skills?folder=<slug>` — a list filter (alongside the existing `status` and `q`); list items and the skill page include `folder: { slug, name }`;
- `POST /api/skills` — a required `folder` field;
- `POST /api/skills/:slug/move` `{ folder }`;
- `POST /api/skills/:slug/restore` — an optional `folder` field: restore and move right away (rule 4).

Errors (`CatalogError` codes → HTTP, as today): `folder_not_found` (404), `folder_exists` (409), `folder_archived` (409), invalid slug (400). Error format and audit — as in the existing routes.

## 10. Web UI

Strings go in `strings.ts`, components are shadcn/Base UI, rules from `CLAUDE.md`.

- **Skills list** (`/skills`): a folder picker (Select "All folders" + active folders) next to the status filter and search; the folder is in the URL (`?folder=`) so the link can be shared. Each skill shows its folder.
- **Folders** (`/folders`): a new navigation item. Table: name, slug, description, number of skills; filter "active / archived". Actions: create (`/folders/new`), edit (name, description; slug is read-only), archive, restore. Clicking a folder → `/skills?folder=<slug>`.
- **Archiving a folder**: a `ConfirmDialog` with the number of skills that will be archived along with it. Afterwards — `notify.success`.
- **Restoring a folder**: a hint in a toast or dialog that the skills stay archived and must be restored separately.
- **Skill page**: the folder (a link to the filtered list) and a "Move" action (a dialog to pick an active folder).
- **Restoring a skill from an archived folder**: a dialog "Folder "X" is archived: restore the folder or move the skill to another folder".
- **New skill** (editor): a required folder choice. If opened from the list with `?folder=`, the folder is preselected.
- If there are no active folders, skill creation shows an empty state with a "Create folder" link.

## 11. Tests

In the order from `CLAUDE.md` ("How to add a use case"):

- domain: `Folder` (creation, validation, archive/restore, idempotency), `Skill` with `folderId` and moving;
- application with fake ports: create in an archived or unknown folder, move, cascading archiving (only active skills, events, audit), restoring a folder does not touch skills, restoring a skill from an archived folder (refusal and the variant with a move);
- Search: folder filter before candidate selection (a skill from the requested folder is found even if another folder has 50+ closer matches), `skill_moved` updates the folder, archiving a folder removes its skills from the index;
- integration (Testcontainers): migration on a database with existing skills (all in "General", `search.documents.folder = 'general'`), the cascade in one transaction, the archive-folder vs create-skill race;
- MCP contract: `list_folders`, `search_skills` with `folders` and with an unknown folder, `folder` in `get_skill`;
- web: folder pages, list filter, moving, archive and restore dialogs, folder choice in the editor (msw);
- e2e: the scenario "create a folder → create a skill in it → find it via the filter → archive the folder → the skill is archived".

Before finishing — `pnpm verify`.

## 12. Implementer's decisions (for owner review)

- The folder slug is immutable; `name` and `description` are editable; the description is required.
- Moving a skill does not create a version.
- A skill cannot be restored into an archived folder; there is "restore into another folder".
- A third MCP tool, `list_folders`, instead of a folder list in the instructions — with ADR 0007.
- `search_skills` with an unknown folder is an error, not a silent empty result: this way the agent learns right away that it got the slug wrong.
- The default folder is `general` / "General"; it can be renamed and archived.
- The folder filter in vector search must actually work before the top-50 selection and with the HNSW index (e.g. `hnsw.iterative_scan` or an equivalent) — verified by the test from section 11.
