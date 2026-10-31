# Subagents Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Store Claude Code subagents in the registry (versioned, searchable, in folders, edited in the web UI) and install, update, uninstall and list them with `skills-registry subagent …`.

**Architecture:** A new `Subagent` aggregate in the `catalog` module, parallel to `Skill` (one `SUBAGENT.md` blob per version, own tables, same folder rules and outbox events). `search.documents` gets a `kind` column so subagents are searchable in the UI but never returned by skill search. The web UI gets a Subagents section with a Form | Raw editor. The CLI renders `.claude/agents/<slug>.md` from the registry's parsed fields and records ownership in `.claude/agents/.skills-registry.json`.

**Tech Stack:** TypeScript, Hono, postgres.js, pgvector, zod, `yaml` 2.9.1, `diff` 9.0.0, React 19 + TanStack Query + shadcn/ui on Base UI, Vitest (`vp test`), Testcontainers, `node:util` `parseArgs`.

**Spec:** `docs/superpowers/specs/2026-10-31-subagents-design.md` — read it before any task; section numbers below (§N) refer to it.

## Global Constraints

- Layering and module rules from `CLAUDE.md` hold (`pnpm arch`): `domain` imports only its own domain, `shared-kernel` and `yaml`; `application` adds `zod`/`diff`; Search reads Catalog only through `modules/catalog/index.ts`; `packages/cli` and `apps/web` import only `@skills/contracts`.
- The entity is always called **subagent** in code, API, UI and CLI; `-a/--agent` keeps meaning the coding agent target (§5).
- `SUBAGENT.md` rules (§6): `name` = slug; `description` non-empty, ≤ 1024 chars; `tools` optional non-empty list, each `^[A-Z][A-Za-z0-9]*$` or `^mcp__[A-Za-z0-9_-]+__[A-Za-z0-9_-]+$`, no duplicates, `[]` rejected; `model` ∈ `inherit | sonnet | opus | haiku`, omitted = `inherit`; `skills` optional, valid slugs, no duplicates, ≤ 20; no other frontmatter keys; whole file ≤ 64 KB (65 536 bytes UTF-8).
- `skills` are checked (each an existing **active** skill, error `unknown_skill`) on create and publish only — never on rollback or restore.
- Subagent slug namespace is separate from skills and folders; slug `new` is reserved for creation.
- Shipped migrations are never edited; new ones are `0011_catalog_subagents.sql`, `0012_search_kinds.sql`.
- UI strings only in `apps/web/src/strings.ts`, English; CSP unchanged; no Radix; prompt Markdown only through the existing sanitized `Markdown` component.
- CLI exit codes: 0 ok, 1 an operation failed, 2 usage error. The token is never printed.
- Existing behaviour of skills, folders, MCP tools and skill CLI commands does not change, except the additions this plan names (`usedBy`, `archivedSubagents`).
- `pnpm verify` green at the end of every task that touches code.

## Review Focus

1. **A YAML-hostile description or prompt** (`description: "x\ntools: Bash"`, a body starting with `---`) must round-trip unchanged through server parse, web Form ↔ Raw and CLI rendering, never producing extra frontmatter keys — tests in Tasks 1, 8, 9.
2. **Folder archive racing a subagent create/move/restore into it** must never leave an active subagent in an archived folder — integration test in Task 3.
3. **A skill and a subagent with the same slug** (`devops`) must coexist in catalog and in the search index without one overwriting or removing the other's document — tests in Tasks 3 and 6.
4. **`subagent update` with a hand-edited installed file** must skip it as foreign, not overwrite it, and still update the rest — test in Task 10.
5. **A subagent whose `skills` became archived after publish** must still load, show, roll back and install (no `unknown_skill` outside create/publish) — tests in Tasks 4 and 9.

---

### Task 1: `SUBAGENT.md` parsing (domain)

**Files:**
- Create: `apps/server/src/modules/catalog/domain/frontmatter.ts`
- Modify: `apps/server/src/modules/catalog/domain/skill-md.ts` (use `splitFrontmatter`; behaviour unchanged)
- Create: `apps/server/src/modules/catalog/domain/subagent-md.ts`
- Modify: `apps/server/src/modules/catalog/domain/errors.ts` (add codes)
- Test: `apps/server/src/modules/catalog/domain/subagent-md.test.ts`

**Interfaces:**
- Produces:
  - `splitFrontmatter(text: string): Result<{ data: Record<string, unknown>; body: string }, CatalogError>` — BOM/CRLF normalisation, the existing `FRONTMATTER_RE`, YAML errors with position only (moved from `skill-md.ts`; `parseSkillMd` keeps its messages, which say `SKILL.md`; make the file name a parameter: `splitFrontmatter(text, fileName: 'SKILL.md' | 'SUBAGENT.md')`).
  - `type SubagentModel = 'inherit' | 'sonnet' | 'opus' | 'haiku'`
  - `type ParsedSubagentMd = { name: string; description: string; tools: string[] | null; model: SubagentModel; skills: string[]; body: string }`
  - `parseSubagentMd(text: string): Result<ParsedSubagentMd, CatalogError>`
  - `MAX_SUBAGENT_MD_BYTES = 65_536`, `MAX_SUBAGENT_SKILLS = 20`
  - `CatalogErrorCode` gains `'subagent_not_found' | 'subagent_exists' | 'subagent_archived' | 'unknown_skill'`.

- [ ] **Step 1: Write the failing tests** in `subagent-md.test.ts`:
  - full example from §6 parses to `{ name: 'devops', tools: ['Bash','Read','Edit','Grep','Glob','mcp__github__create_pull_request'], model: 'sonnet', skills: ['release-runbook','docker-conventions'], body: 'You are…' }`;
  - only `name`+`description` → `tools: null`, `model: 'inherit'`, `skills: []`, `body: ''`;
  - each rejected with `invalid_frontmatter`: missing name, empty description, description of 1025 chars, `tools: []`, `tools: [read]`, `tools: ['mcp__github__*']`, `tools: [Read, Read]`, `tools: Read` (not a list), `model: gpt`, `skills: [Not_A_Slug]`, `skills: [a, a]`, 21 skills, unknown key `color: red`;
  - 65 537-byte file → `limit_exceeded`; a 65 536-byte file with multibyte characters counted in bytes;
  - a description containing `"\ntools: Bash"` (quoted YAML) parses as that literal string and `tools` stays `null`;
  - existing `skill-md.test.ts` still passes unchanged.
- [ ] **Step 2: Run** `pnpm vp test apps/server/src/modules/catalog/domain` — expected: the new tests FAIL (module not found).
- [ ] **Step 3: Implement** `frontmatter.ts`, refactor `skill-md.ts` onto it, implement `subagent-md.ts`, add the error codes. Skill slugs are checked with `Slug.parse`.
- [ ] **Step 4: Run** the same command — expected: PASS.
- [ ] **Step 5: Commit** `feat(catalog): parse SUBAGENT.md`.

### Task 2: `Subagent` aggregate and events (domain)

**Files:**
- Create: `apps/server/src/modules/catalog/domain/subagent.ts`
- Modify: `apps/server/src/modules/catalog/domain/events.ts`
- Test: `apps/server/src/modules/catalog/domain/subagent.test.ts`

**Interfaces:**
- Consumes: `ParsedSubagentMd`, `SubagentModel` (Task 1), `ContentHash`, `Slug`.
- Produces:
  - events `subagentVersionCreated({ subagentId, slug, version }, at)`, `subagentArchived({ subagentId, slug }, at)`, `subagentRestored({ subagentId, slug }, at)`, `subagentMoved({ subagentId, slug, folder }, at)` with types `catalog.subagent_version_created`, `catalog.subagent_archived`, `catalog.subagent_restored`, `catalog.subagent_moved`;
  - `type SubagentStatus = 'active' | 'archived'`
  - `interface SubagentVersion { number; name; description; tools: readonly string[] | null; model: SubagentModel; skills: readonly string[]; contentHash: ContentHash; size: number; authorId; message: string | null; createdAt: Date; restoredFrom: number | null }`
  - `class Subagent` with the same shape and semantics as `Skill` minus source/manifest: `static create({ id, slug, folderId, md, contentHash, size, authorId, message, now })`, `static rehydrate({ id, slug, folderId, status, latest, updatedAt })`, getters `id`, `slug`, `folderId`, `loadedFolderId`, `status`, `latest`, `currentVersion`, `updatedAt`, methods `assertWritable(baseVersion)`, `publish({ md, contentHash, size, authorId, message, now, baseVersion })`, `rollback({ toVersion, baseVersion, authorId, now })` (message `Rollback to version N`, `restoredFrom`), `archive(now)`, `restore(now)`, `moveTo({ folderId, folderSlug, now }): Result<boolean>`, `pullEvents()`. Errors: `name_mismatch`, `subagent_archived`, `version_conflict`.

- [ ] **Step 1: Write the failing tests** mirroring `skill.test.ts` for: create (v1, event), name ≠ slug, publish on stale base → `version_conflict`, publish when archived → `subagent_archived`, rollback copies tools/model/skills/content of the target and sets `restoredFrom`, archive/restore idempotent with one event each, move to same folder → `ok(false)` no event, move when archived → error.
- [ ] **Step 2: Run** `pnpm vp test apps/server/src/modules/catalog/domain/subagent.test.ts` — FAIL.
- [ ] **Step 3: Implement.** Do not refactor `Skill`.
- [ ] **Step 4: Run** — PASS.
- [ ] **Step 5: Commit** `feat(catalog): Subagent aggregate`.

### Task 3: Ports, Postgres repository, migration, folder cascade

**Files:**
- Modify: `apps/server/src/modules/catalog/application/ports.ts`, `application/deps.ts`
- Create: `apps/server/migrations/0011_catalog_subagents.sql`
- Create: `apps/server/src/modules/catalog/infrastructure/pg-subagent-repository.ts`
- Modify: `apps/server/src/modules/catalog/infrastructure/pg-folder-repository.ts` (`archiveWithSkills`)
- Modify: `apps/server/src/modules/catalog/index.ts` (`createPgCatalog` returns `subagents`)
- Create: `apps/server/test/fakes/in-memory-subagent-repository.ts`; modify `apps/server/test/fakes/catalog-deps.ts`, `in-memory-folder-repository.ts`
- Test: `apps/server/test/catalog/pg-subagent-repository.int.test.ts`; extend `apps/server/test/catalog/pg-folder-repository.int.test.ts`

**Interfaces:**
- Consumes: `Subagent`, `SubagentVersion` (Task 2).
- Produces (in `ports.ts`):
  - `type SubagentSummary = { slug; name; description; status: SubagentStatus; version: number; updatedAt: Date; folder: FolderRef; model: SubagentModel; tools: string[] | null; skills: string[] }`
  - `type SubagentListFilter = { status: SubagentStatus | 'all'; folder: string | null }`
  - `interface SubagentRepository { findBySlug(slug: Slug); findById(id); getVersion(id, n); listVersions(id); listSummaries(filter): Promise<SubagentSummary[]> /* by slug, one query */; listActiveInFolder(folderId): Promise<Subagent[]>; usedBy(skillSlug: string): Promise<string[]> /* active subagents whose latest version lists it, by slug */; save(subagent, blobs: Map<string, Uint8Array>): Promise<void> }` — `save` semantics exactly as `SkillRepository.save` (folder row `for share` when created/restored/moved while active, CAS, outbox, `subagent_exists` on the slug unique key);
  - `FolderRepository.archiveWithSkills(folder, skills: Skill[], subagents: Subagent[])` — also locks the folder's active subagent ids `for update`, which must equal `subagents`, else `version_conflict`;
  - `CatalogDeps.subagents: SubagentRepository`;
  - `writeSubagent(tx, subagent, blobs)` exported from `pg-subagent-repository.ts` (as `writeSkill`).
- Migration `0011_catalog_subagents.sql`: `catalog.subagents (id uuid pk, slug text unique not null, folder_id uuid not null references catalog.folders(id), status text check active|archived, current_version int not null, created_at, updated_at)` + index on `folder_id`; `catalog.subagent_versions (subagent_id uuid references catalog.subagents(id), number int, name, description, tools text[] null, model text not null check in the four values, skills text[] not null, content_hash char(64) not null references catalog.blobs(hash), size int not null, author_id uuid not null, message text, created_at timestamptz not null, restored_from int, primary key (subagent_id, number))` + GIN index on `skills`.

- [ ] **Step 1: Write the failing integration tests**: save/find round trip (tools `null` vs list preserved); concurrent publish on the same base → one `version_conflict`; `listSummaries` with status and folder filters; `usedBy('release-runbook')` returns only active subagents whose **latest** version lists it; a subagent and a skill both slugged `devops` save and load independently; `archiveWithSkills` archives skills **and** subagents and writes `catalog.subagent_archived` to the outbox; a subagent created into the folder between listing and archiving → `version_conflict`; a create into a folder whose archive holds the lock ends as `folder_archived` (same pattern as the existing skill race test).
- [ ] **Step 2: Run** `pnpm test:int -- pg-subagent-repository pg-folder-repository` — FAIL.
- [ ] **Step 3: Implement** migration, repository, the extended `archiveWithSkills`, in-memory fakes with the same contract. Until Task 4, `archiveFolder` passes `[]` as `subagents` so the build stays green.
- [ ] **Step 4: Run** — PASS; `pnpm test:int` for the whole catalog folder still green.
- [ ] **Step 5: Commit** `feat(catalog): subagent storage`.

### Task 4: Subagent use cases (application)

**Files:**
- Create: `apps/server/src/modules/catalog/application/commands/subagents.ts` (create, publish, rollback, archive, restore, move)
- Create: `apps/server/src/modules/catalog/application/queries/subagents.ts` (get, list, history, diff)
- Modify: `application/commands/folders.ts` (`archiveFolder` cascades to subagents), `application/queries/get-skill.ts` (`usedBy`), `modules/catalog/index.ts` (exports)
- Test: `apps/server/src/modules/catalog/application/subagents.test.ts`; extend `folders.test.ts`, `catalog.test.ts`

**Interfaces:**
- Consumes: Tasks 1–3.
- Produces (all exported from `modules/catalog/index.ts`):
  - `createSubagent(deps, { slug, folder, content: string, actorId, message: string | null }): Promise<Result<{ slug: string; version: number }, CatalogError>>`
  - `publishSubagent(deps, { slug, baseVersion, content, actorId, message }): Promise<Result<{ slug; version }>>`
  - `rollbackSubagent(deps, { slug, toVersion, baseVersion, actorId })`
  - `archiveSubagent(deps, { slug, actorId }): Promise<Result<void>>`, `restoreSubagent(deps, { slug, actorId, folder?: string })`, `moveSubagent(deps, { slug, folder, actorId })`
  - `type SubagentView = SubagentSummary & { content: string }` where `version`, `name`, `description`, `model`, `tools`, `skills` are of the **shown** version; `getSubagent(deps, { slug, version? }): Promise<Result<SubagentView>>`
  - `listSubagents(deps, { status, folder? }): Promise<SubagentSummary[]>`
  - `type SubagentVersionSummary = { number; authorId; message; createdAt; restoredFrom }`; `getSubagentHistory(deps, { slug })`
  - `type SubagentDiff = { patch: string | null; tools: { from: string[] | null; to: string[] | null } }`; `diffSubagentVersions(deps, { slug, from, to })` — `patch` is a unified diff of the two `SUBAGENT.md` texts (`diff` package, as `queries/diff.ts`), `null` when equal
  - `SkillView.usedBy: string[]`
  - `archiveFolder` result becomes `{ archivedSkills: number; archivedSubagents: number }`
- Behaviour: content → UTF-8 bytes → `hasher.sha256` → blob map; `unknown_skill` message `skill "<slug>" is not an active skill` for the first offending slug; reserved slug `new` rejected on create (`Slug.reservedError(slug, 'subagent')` — widen its `kind` union); `restoreSubagent` follows `restoreSkill` (folder archived → `folder_archived`, `folder` given → restore + move in one save); audit actions `subagent.create {version: 1, folder}`, `subagent.publish {version}`, `subagent.rollback {version}`, `subagent.archive {version}`, `subagent.restore {version}`, `subagent.move {from, to}`; `archiveFolder` audit `folder.archive` meta `{ archivedSkills, archivedSubagents }` and `subagent.archive {version, viaFolder}` per subagent.

- [ ] **Step 1: Write the failing tests** (fake ports): create with an unknown skill and with an archived skill → `unknown_skill`; create into archived folder → `folder_archived`; create twice → `subagent_exists`; slug `new` → `invalid_slug`; publish with changed tools bumps version and emits the event; rollback to a version that lists a skill archived since → succeeds; restore with a now-archived skill listed → succeeds; get with `version` returns that version's fields; diff returns `tools.from/to` and `patch: null` for identical versions; `archiveFolder` archives skills and subagents and records both counts; `getSkill` returns `usedBy`; every command records the audit entry above.
- [ ] **Step 2: Run** `pnpm vp test apps/server/src/modules/catalog/application` — FAIL.
- [ ] **Step 3: Implement.** Reuse `loadActiveFolder`, `archivedError`, the `write`/`save` error translation pattern.
- [ ] **Step 4: Run** — PASS; `pnpm test` coverage for domain/application stays ≥ 90 %.
- [ ] **Step 5: Commit** `feat(catalog): subagent use cases`.

### Task 5: Contracts and `/api/subagents`

**Files:**
- Create: `packages/contracts/src/subagents.ts`; modify `packages/contracts/src/index.ts`, `skills.ts` (`SkillView.usedBy`), `folders.ts` (`ArchiveFolderResponse.archivedSubagents`)
- Create: `apps/server/src/modules/catalog/interfaces/http/subagents.ts`
- Modify: `apps/server/src/platform/http/app.ts`, `apps/server/src/platform/http/errors.ts`
- Test: `packages/contracts/src/subagents.test.ts`; `apps/server/test/http/subagents.int.test.ts`

**Interfaces:**
- Consumes: Task 4 use cases.
- Produces (contracts):
  - `SubagentModel = z.enum(['inherit','sonnet','opus','haiku'])`, `BUILTIN_TOOL_PATTERN`, `MCP_TOOL_PATTERN` (the regexes from Global Constraints), `MAX_SUBAGENT_MD_BYTES = 65_536`
  - `ListSubagentsQuery` (same fields as `ListSkillsQuery`)
  - `CreateSubagentRequest = { slug ≤200, folder ≤200, content: string ≤ 65_536 chars, message? ≤2000 }`, `PublishSubagentRequest = { content, baseVersion: int ≥1, message? }`
  - `SubagentSummary = { slug, name, description, status: SkillStatus, folder: FolderRef, version, updatedAt: iso, model: SubagentModel, tools: string[] | null, skills: string[] }`, `SubagentView = SubagentSummary.extend({ content })`, `SubagentVersionSummary = VersionSummary.omit({ sourceCommit: true })`, `SubagentDiff = { patch: string | null, tools: { from, to } }`
  - Rollback/move/restore reuse `RollbackRequest`, `MoveSkillRequest`, `RestoreSkillRequest`; create/publish/rollback answer `VersionRef`.
- Routes exactly as §8 table; JSON bodies limited with `limitBody` to 256 KB; `GET /` with `q` orders by a `SearchSlugs` callback (wired to Search in Task 6 — until then `app.ts` passes a callback returning `[]` for subagents).
- `errors.ts` STATUS: `subagent_not_found: 404`, `subagent_exists: 409`, `subagent_archived: 409`, `unknown_skill: 422`.

- [ ] **Step 1: Write the failing tests**: contracts parse a server sample and reject `model: 'gpt'`; integration: the whole lifecycle through HTTP with a session cookie (create → get → publish → history → diff → rollback → move → archive → restore) and once with a Bearer token without `Origin`; a session mutation without `Origin` → 403 `csrf`; `GET /api/skills/:slug` includes `usedBy`; status codes for the four new error codes; `POST /api/folders/:slug/archive` returns `archivedSubagents`.
- [ ] **Step 2: Run** `pnpm vp test packages/contracts && pnpm test:int -- subagents` — FAIL.
- [ ] **Step 3: Implement** contracts, routes (mirror `interfaces/http/skills.ts`, author logins via `LoginsByIds`), wiring.
- [ ] **Step 4: Run** — PASS.
- [ ] **Step 5: Commit** `feat(api): /api/subagents`.

### Task 6: Search over subagents

**Files:**
- Create: `apps/server/migrations/0012_search_kinds.sql`
- Modify: `apps/server/src/modules/search/application/{ports,index-skill,event-handlers,reindex-all,index-missing-embeddings,search-skills}.ts`, `infrastructure/pg-search-index.ts`, `index.ts`
- Create: `apps/server/src/modules/search/application/index-subagent.ts`, `infrastructure/catalog-subagent-reader.ts`
- Modify: `apps/server/src/platform/container.ts`, `apps/server/src/platform/http/app.ts`
- Test: extend `apps/server/src/modules/search/application/search.test.ts` and the search integration tests in `apps/server/test/search/`

**Interfaces:**
- Consumes: `getSubagent`, `listSubagents` (Task 4), the route callback slot (Task 5).
- Produces:
  - `type DocumentKind = 'skill' | 'subagent'`; `IndexedDocument.kind`; `DocumentSummary` unchanged
  - `SearchIndex`: `remove(kind, slug)`, `slugs(kind)`, `slugsWithoutEmbedding(limit): Promise<{ kind: DocumentKind; slug: string }[]>`, `markEmbedFailed(kind, slug)`, `ftsCandidates(kind, query, limit, folders)`, `vectorCandidates(kind, embedding, limit, minSimilarity, folders)`, `summaries(kind, slugs)`; `upsert` keyed on `(kind, slug)`
  - `interface SubagentReader { get(slug): Promise<{ slug; name; description; body: string; status; version; folder } | null>; listSlugs(): Promise<string[]> }`; `SearchDeps.subagents: SubagentReader`; `createCatalogSubagentReader(catalog)`
  - `indexSubagent(deps, { slug })` (passage: name, description, body; same embed-failure semantics as `indexSkill`)
  - `searchSubagents(deps, { query, limit, folders? }): Promise<SearchHit[]>`; `searchSkills` unchanged in signature, filtered to `kind = 'skill'` before the candidate limit
  - event handlers for the four `catalog.subagent_*` types → `indexSubagent`; `reindexAll` covers both kinds and returns the total; the sweep dispatches by kind; `SweepResult.indexed/failed` become `kind:slug` strings
- Migration `0012_search_kinds.sql`: add `kind text not null default 'skill' check (kind in ('skill','subagent'))`, drop the default, replace the primary key `slug` with `(kind, slug)`, index on `kind`.

- [ ] **Step 1: Write the failing tests**: a skill and a subagent both `devops` are both indexed; archiving the subagent removes only its document; `searchSkills` never returns a subagent even when the subagent is the best FTS and vector match (filter before the top-50); `searchSubagents` with a folder filter; `GET /api/subagents?q=deploy` returns subagents in relevance order; MCP `search_skills` returns no subagents; `reindexAll` indexes both kinds and drops stale documents of each kind; the embedding sweep fills a subagent document.
- [ ] **Step 2: Run** `pnpm vp test apps/server/src/modules/search && pnpm test:int -- search mcp` — FAIL.
- [ ] **Step 3: Implement**, wire `searchSubagents` into the subagent routes in `app.ts`.
- [ ] **Step 4: Run** — PASS.
- [ ] **Step 5: Commit** `feat(search): index and search subagents`.

### Task 7: Web — list, view, navigation, "Used by"

**Files:**
- Modify: `apps/web/src/api/queries.ts`, `apps/web/src/app/routes.tsx`, `apps/web/src/app/Layout.tsx`, `apps/web/src/strings.ts`, `apps/web/src/skills/SkillPage.tsx`, `apps/web/test/msw/handlers.ts`
- Create: `apps/web/src/subagents/SubagentsListPage.tsx`, `apps/web/src/subagents/SubagentPage.tsx`
- Test: `apps/web/src/subagents/list.test.tsx`, `apps/web/src/subagents/subagent.test.tsx`; extend `apps/web/src/skills/skill.test.tsx`

**Interfaces:**
- Consumes: contracts (Task 5).
- Produces (`queries.ts`): keys `subagents: ['subagents']`, `subagentList(status, q, folder)`, `subagent(slug): ['subagent', slug]`, `subagentView(slug, version)`, `subagentHistory(slug)`, `subagentDiff(slug, from, to)`; hooks `useSubagents({ status, q, folder })`, `useSubagent(slug, version?)`, `useSubagentHistory(slug)`, `useSubagentDiff(slug, from, to)`, `useCreateSubagent()`, `usePublishSubagent(slug)`, `useRollbackSubagent(slug)`, `useArchiveSubagent(slug)`, `useRestoreSubagent(slug)`, `useMoveSubagent(slug)` — mutations invalidate `subagents` and `subagent(slug)`, and `skills` (for `usedBy`).
- Routes: `/subagents`, `/subagents/new`, `/subagents/:slug`, `/subagents/:slug/edit`, `/subagents/:slug/history`, `/subagents/:slug/diff` (editor/history/diff pages arrive in Task 8; until then the existing `soon` placeholder).
- Nav item between Skills and Folders, label `strings.nav.subagents = 'Subagents'`, lucide `BotIcon`.
- View page (§10): description, model, tools (or "All tools"), skills as links to `/skills/:slug`, prompt via `Markdown`, `CopyField` with `skills-registry subagent install <slug>`, archive/restore/move actions reusing `MoveSkillDialog`/`RestoreSkillDialog` (parameterise them by the mutation if needed).
- Skill page: "Used by" line with links when `usedBy` is non-empty.

- [ ] **Step 1: Write the failing tests** (msw + `renderWithApp`): list renders rows, filters by folder and status, search sends `q`; view shows tools, "All tools" for `tools: null`, skill links, the install command; a prompt containing `<script>` renders as text; archive flow shows a toast; skill page shows "Used by".
- [ ] **Step 2: Run** `pnpm vp test --project web apps/web/src/subagents apps/web/src/skills` — FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** — PASS.
- [ ] **Step 5: Commit** `feat(web): subagents list and page`.

### Task 8: Web — editor, history, diff

**Files:**
- Modify: `apps/web/package.json` (add `yaml` 2.9.1), `apps/web/src/app/routes.tsx`, `apps/web/src/strings.ts`
- Create: `apps/web/src/subagents/subagent-md.ts`, `SubagentEditorPage.tsx`, `ToolsField.tsx`, `SkillsField.tsx`, `SubagentHistoryPage.tsx`, `SubagentDiffPage.tsx`
- Test: `apps/web/src/subagents/subagent-md.test.ts`, `editor.test.tsx`, `history.test.tsx`

**Interfaces:**
- Consumes: Task 7 hooks; `CodeEditor`, `DiffView`, `parsePatch` from `apps/web/src`.
- Produces:
  - `type SubagentForm = { name: string; description: string; model: SubagentModel; tools: string[] | null; skills: string[]; body: string }`
  - `parseSubagentForm(text: string): { ok: true; value: SubagentForm } | { ok: false; error: string }` (client-side check of the §6 rules, for switching to Form; the server stays authoritative)
  - `serializeSubagentForm(form: SubagentForm): string` — `yaml` `stringify` of `name`, `description`, then `tools`, `model` (omitted when `inherit`), `skills` (omitted when empty); `---` fences; body after a newline.
- Editor (§10): Form | Raw tabs over one text; Raw → Form blocked with the parse error shown when the text does not parse; tools checkboxes `Read, Grep, Glob, Edit, Write, Bash, WebFetch, WebSearch`, free entry for others, "Inherit all tools" toggle, at least one tool when off; skills picker with autocomplete over `useSkills({ status: 'active', q })`; folder via `FolderPicker`; slug only on create; message + Publish; unsaved-changes guard as in `EditorPage`; server errors under the field: `unknown_skill` → Skills, `invalid_frontmatter` mentioning `tools` → Tools, otherwise above the form.
- History page as `HistoryPage` with rollback; diff page: when `tools.from` ≠ `tools.to`, a "Permissions changed" block listing added and removed tools (and "All tools" for `null`), above `DiffView` of `patch`.

- [ ] **Step 1: Write the failing tests**: `parseSubagentForm(serializeSubagentForm(f))` deep-equals `f` for forms with `tools: null`, MCP tools, a description with `: `, quotes and a newline, a body starting with `---`; Raw text with an unknown key cannot switch to Form and shows the error; creating sends `POST /api/subagents` with the serialized content; `unknown_skill` appears under Skills; turning off "Inherit all tools" with nothing checked blocks Publish; navigating away with changes asks to confirm; diff page shows "Permissions changed" with `+ Bash` / `- Write`, and no block when tools are equal.
- [ ] **Step 2: Run** `pnpm vp test --project web apps/web/src/subagents` — FAIL.
- [ ] **Step 3: Implement.** Check `e2e/editor-csp.spec.ts` patterns still hold (no `<style>` from new code).
- [ ] **Step 4: Run** — PASS; `pnpm build:web` succeeds.
- [ ] **Step 5: Commit** `feat(web): subagent editor, history and diff`.

### Task 9: CLI — registry client, rendering, ownership manifest

**Files:**
- Modify: `packages/cli/src/registry.ts`
- Create: `packages/cli/src/subagents/render.ts`, `packages/cli/src/subagents/installed.ts`, `packages/cli/src/subagents/target.ts`
- Modify: `packages/cli/test/registry-fixtures.ts`
- Test: `packages/cli/src/subagents/render.test.ts`, `installed.test.ts`, `target.test.ts`

**Interfaces:**
- Consumes: contracts `SubagentSummary`, `SubagentView`, `BUILTIN_TOOL_PATTERN`, `MCP_TOOL_PATTERN`, `SubagentModel`.
- Produces:
  - `RegistryClient.listSubagents(q: { folder?: string; status?: SkillStatusFilter }): Promise<SubagentSummary[]>`, `RegistryClient.getSubagent(slug: string): Promise<SubagentView | null>` (404 → `null`)
  - `renderSubagent(v: SubagentView, mcpServer: string): string` — frontmatter via `yaml` `stringify({ name, description, tools?, model? })`, `tools` as `'A, B'`, `model` omitted for `inherit`; when `v.skills` is non-empty and `v.tools` is set, append `mcp__<mcpServer>__get_skill` and `mcp__<mcpServer>__search_skills` (no duplicates); when `v.skills` is non-empty, prepend to the body exactly:
    ```
    Before starting, load each of these skills with the `get_skill` tool of the `<mcpServer>` MCP server and follow them: `a`, `b`.
    If a skill cannot be loaded, stop and report it instead of improvising.

    ```
    Throws `Error('invalid subagent from the registry: …')` if a tool, the model or the slug fails the shared patterns.
  - `MCP_SERVER_RE = /^[A-Za-z0-9_-]+$/` for `--mcp-server`
  - `type InstalledEntry = { server: string; version: number; sha256: string; mcpServer: string; tools: string[] | null }`; `type InstalledManifest = { subagents: Record<string, InstalledEntry> }`
  - `agentsDir(env: Pick<CliEnv,'cwd'|'home'>, global: boolean): string` → `<cwd or home>/.claude/agents`
  - `readInstalled(dir): Promise<InstalledManifest>` (missing or invalid file → empty), `writeInstalled(dir, m): Promise<void>` (temp + rename), `inspectSubagent(dir, slug, server, m): Promise<'absent' | 'foreign' | InstalledEntry>` (ours = entry for the slug from `server` and the file's sha256 matches), `writeSubagentFile(dir, slug, text): Promise<void>` (creates `dir`, temp + rename; slug checked with `checkSlug`)
  - `selectSubagentTarget(ids: string[], env): 'claude-code'` — `[]` → `claude-code` if `~/.claude` exists, else `UsageError('no supported coding agent found; pass -a claude-code')`; `'claude-code'` or `'*'` → `'claude-code'`; another known agent id → `UsageError('<id> does not support subagents (supported: claude-code)')`; unknown id → the same message as `selectAgents` uses.

- [ ] **Step 1: Write the failing tests**: rendering of §6 example equals a fixed expected file; `tools: null` → no `tools` line and no appended MCP tools, but the skills block is present; custom `--mcp-server registry` appears in both tools and block; a description with `"\nmodel: opus"` renders as a quoted scalar and `yaml.parse` of the output frontmatter has exactly the expected keys; a body starting with `---` stays in the body; a view with `model: 'gpt'` throws; `inspectSubagent` returns `absent`, ours, `foreign` (edited file), `foreign` (other server); `selectSubagentTarget` cases above.
- [ ] **Step 2: Run** `pnpm vp test packages/cli/src/subagents` — FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** — PASS.
- [ ] **Step 5: Commit** `feat(cli): render and track installed subagents`.

### Task 10: CLI — `subagent` commands

**Files:**
- Create: `packages/cli/src/commands/subagent.ts` (dispatcher), `subagent-install.ts`, `subagent-update.ts`, `subagent-uninstall.ts`, `subagent-list.ts`
- Modify: `packages/cli/src/cli.ts` (command + usage text)
- Test: `packages/cli/src/commands/subagent.test.ts`; extend `apps/server/test/cli-client/cli.int.test.ts`

**Interfaces:**
- Consumes: Task 9.
- Produces: `subagentCommand: Command` handling `install | update | uninstall | list`; unknown or missing subcommand → usage error (exit 2). Options as §11.1: `-g/--global`, `-a/--agent` (multiple), `--folder`, `--mcp-server` (default `skills`), `--force`, `--yes`, `--installed`.
- Behaviour: exactly §11.4–§11.5. Output lines:
  - install: `installed <slug> v<N> (model <m>; tools <list | all tools>; skills <list | none>) → <path>`; `<slug> v<N> is already installed`; conflicts `conflict: <path> was not installed by skills-registry or was modified; use --force`;
  - update: `<slug> is up to date (v<N>)`, `updated <slug> v<A> → v<B> (<changed fields>)`, gate to stderr `permissions changed for <slug>: +Bash -Write; rerun with --yes to apply`;
  - list (registry): `<slug>\tv<version>\t<folder>\t<description>` through `safe()`;
  - list --installed: `<slug>\tv<installed>\t<latest, with ' ↑' when newer>\t<ok|modified|archived|missing>`.
  - Exit 1 when any subagent failed, was skipped as foreign, or was held by the gate.

- [ ] **Step 1: Write the failing tests** (fake env, fake fetch with fixtures): install one, several and `--folder`; reinstall same version; install older → newer applies with the gate; install over a hand-written file → conflict, `--force` overwrites; update all with one hand-edited file (skipped, others updated, exit 1); update with changed tools without `--yes` (file untouched, exit 1) and with `--yes`; update where the listed skills changed but tools did not (applied, no gate); uninstall ours and foreign; uninstall `--folder`; list and list `--installed` showing `↑`, `modified`, `archived`, `missing`; `-a cursor` → exit 2 with the message; `-g` writes under home. Integration (`cli.int.test.ts`): against a real server — `subagent install devops -a claude-code` → publish a version with changed tools via the API → `subagent update` exits 1 → `subagent update --yes` exits 0 and the file contains the new tools.
- [ ] **Step 2: Run** `pnpm vp test packages/cli && pnpm test:int -- cli-client` — FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** — PASS; `pnpm build:cli` succeeds and `node packages/cli/dist/cli.js subagent --help` prints the usage.
- [ ] **Step 5: Commit** `feat(cli): subagent install, update, uninstall, list`.

### Task 11: Docs and final verification

**Files:**
- Create: `docs/adr/0010-subagents.md`
- Modify: `CLAUDE.md` (glossary: Subagent, SubagentVersion; schema list), `README.md` (UI section, `subagent` commands)
- Modify: `e2e/ui.spec.ts` or a new `e2e/subagents.spec.ts` (create a subagent in the UI, see it in the list; CSP spec still passes)

- [ ] **Step 1: Write** the ADR (context, decision: separate aggregate, static permissions + dynamic skills, `-a` convention kept; consequences), the `CLAUDE.md` and README additions.
- [ ] **Step 2: Add** the Playwright scenario.
- [ ] **Step 3: Run** `pnpm verify` — expected: all green; then `pnpm test:e2e` — expected: all green.
- [ ] **Step 4: Commit** `docs: subagents ADR, glossary and README`.

---

## Parallelism

Tasks 1 → 2 → 3 → 4 → 5 are sequential: each consumes the previous interfaces. After Task 5, three independent tracks run in parallel in separate worktrees: **Search** (Task 6), **Web** (Tasks 7 → 8), **CLI** (Tasks 9 → 10). Task 11 runs last on the merged branch.
