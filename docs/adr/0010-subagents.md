# 0010. Subagents

## Context

The owner builds projects with a team of role-specific agents (DevOps, developer, tester, reviewer). In Claude Code a role is a subagent: a markdown file in `.claude/agents/` with a role prompt, a tool whitelist and a model. Such files were written by hand and copied between projects, and the knowledge each role needs was duplicated in the prompts. The registry already stores, versions and serves skills; a subagent is the same kind of artifact (markdown with frontmatter). See `docs/superpowers/specs/2026-10-31-subagents-design.md`.

## Decision

1. **A separate aggregate.** `Subagent` / `SubagentVersion` live in `catalog` next to `Skill`, with their own tables (`catalog.subagents`, `catalog.subagent_versions`), slug namespace, events (`catalog.subagent_*`) and audit actions (`subagent.*`). A subagent is one file, `SUBAGENT.md`, with frontmatter `name`, `description`, `tools`, `model`, `skills`; unknown keys are rejected. Folders, archiving, compare-and-set publishing and rollback work as for skills; archiving a folder archives its subagents too.
2. **Static permissions, dynamic skills.** The CLI installs the subagent as a file, so its `tools` are pinned on the user's disk and change only through an explicit `subagent update`. An update that changes `tools` is shown as a diff, skipped and exits 1 unless `--yes`. The skills a subagent needs are listed by slug and loaded at run time over MCP (`get_skill`), always the latest version, with no pinning. A bad skill can steer an agent but cannot widen its tools; a fixed skill reaches every installed subagent with nothing to reinstall.
3. **Search by kind.** `search.documents` gets `kind` (`skill` | `subagent`); the key is `(kind, slug)`. `search_skills` and `GET /api/skills?q=` filter on `kind = 'skill'` before the top-50 cut-off, so subagents never reach agents over MCP. The UI searches subagents with the same hybrid search.
4. **CLI.** Commands live in their own group, `skills-registry subagent list|install|update|uninstall`. The `vercel-labs/skills` convention is kept: `-a/--agent` is the coding-agent target (only `claude-code` in v1), `-g` is global. The installed frontmatter is generated with the `yaml` library, never copied. Ownership is recorded in `.claude/agents/.skills-registry.json`; the CLI touches only files it installed (matching sha256).
5. **Naming.** In the CLI, API and UI the entity is always called "subagent", because "agent" already means the coding-agent target.

## Alternatives

- **A flag on `Skill`** (`kind: subagent`). Would reuse tables, but a subagent is one file with its own frontmatter schema, no extra files and a different install path; branching on kind across every skill use case and the MCP tools would leak subagents into agent results.
- **Loading subagents over MCP at run time.** Delivers the latest prompt, but also lets a registry edit widen permissions without the user seeing it. Rejected for v1.
- **Pinning skill versions inside a subagent.** More reproducible, but defeats "fix a skill once"; left for later.
- **Renaming `-a`.** Would diverge from the skill commands and the `vercel-labs/skills` convention.

## Consequences

- Permissions of an installed subagent change only with the user's consent; the cost is that prompt and model changes need `subagent update`.
- Skills a subagent references are not protected: archiving one is allowed, and keeping references valid is the admins' responsibility.
- The installed subagent needs the registry's MCP server connected under a known name (`--mcp-server`, default `skills`).
- Search, outbox and reindex deal with documents of two kinds; `reindex` reports documents.
- Teams, GitHub import, other install targets and `get_subagent` over MCP are left for later.
