# 0007. Folders in MCP

## Context

Skills are grouped into folders by topic or project (`docs/superpowers/specs/2026-10-29-skill-folders-design.md`). The agent needs to be able to narrow search to the relevant folders, but for that it has to know their slugs. The folder list changes: users create, rename and archive folders in the UI.

## Decision

1. A third tool, `list_folders` (read-only): active folders with slug, name, description and the number of active skills.
2. `search_skills` gets an optional `folders` parameter (slugs from `list_folders`, 1–20). The filter is applied before the `limit` cut-off. Duplicate slugs are collapsed.
3. An unknown, archived or differently-cased slug produces the tool error `Unknown folder "<slug>". Call list_folders.`, and no search is run.
4. Results of `search_skills` and `get_skill` contain a `folder` field (slug).
5. The server instructions get one sentence: if the task clearly belongs to some folders, call `list_folders` and pass their slugs to `search_skills`; otherwise search everything.

## Alternatives

- **Folder list in `instructions`.** The client reads the instructions once on connect, so the list goes stale after the very first folder change, and every session pays tokens for it.
- **Empty result for an unknown slug.** A typo is indistinguishable from "nothing matches", and the agent concludes there is no skill. An explicit error with a hint is fixed in one call.
- **Filter after search.** The top results may all be in other folders, and the relevant ones get lost to `limit`.

## Consequences

- The agent's context holds one short tool description instead of a folder list.
- The agent spends an extra `list_folders` call only when the task clearly belongs to a folder.
- Renaming a folder does not break clients: the slug is immutable. Archiving a folder makes its slug invalid in `folders` until it is restored.
