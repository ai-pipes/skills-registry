import { DOCUMENT_KINDS, catalogSlugs, indexDocument } from './index-document.ts';
import type { DocumentRef, SearchDeps } from './ports.ts';

/**
 * Rebuilds the index from the catalog, skills and subagents, and drops documents of vanished
 * items of each kind. Returns the number of indexed (active) documents of both kinds. An
 * embedder failure does not stop the run: every document still gets its FTS row, then the
 * first error is rethrown.
 */
export async function reindexAll(deps: SearchDeps): Promise<number> {
  const perKind = await Promise.all(
    DOCUMENT_KINDS.map(async (kind): Promise<DocumentRef[]> => {
      const slugs = await catalogSlugs(deps, kind);
      const known = new Set(slugs);
      const stale = (await deps.index.slugs(kind)).filter((s) => !known.has(s));
      await Promise.all(stale.map((slug) => deps.index.remove(kind, slug)));
      return slugs.map((slug) => ({ kind, slug }));
    }),
  );
  const refs = perKind.flat();
  // Sequential: one embedding call at a time.
  const failure = await refs.reduce<Promise<unknown>>(async (prev, ref) => {
    const first = await prev;
    try {
      await indexDocument(deps, ref);
    } catch (error) {
      return first ?? error;
    }
    return first;
  }, Promise.resolve(null));
  if (failure !== null) throw failure;
  const counts = await Promise.all(DOCUMENT_KINDS.map((kind) => deps.index.slugs(kind)));
  return counts.reduce((n, slugs) => n + slugs.length, 0);
}
