import { indexSkill } from './index-skill.ts';
import { indexSubagent } from './index-subagent.ts';
import type { DocumentKind, DocumentRef, SearchDeps } from './ports.ts';

export const DOCUMENT_KINDS: readonly DocumentKind[] = ['skill', 'subagent'];

/** Re-syncs one document from the catalog, by kind. */
export function indexDocument(deps: SearchDeps, ref: DocumentRef): Promise<void> {
  return ref.kind === 'skill'
    ? indexSkill(deps, { slug: ref.slug })
    : indexSubagent(deps, { slug: ref.slug });
}

/** Slugs of every catalog item of `kind`, active and archived. */
export function catalogSlugs(deps: SearchDeps, kind: DocumentKind): Promise<string[]> {
  return kind === 'skill' ? deps.skills.listSlugs() : deps.subagents.listSlugs();
}
