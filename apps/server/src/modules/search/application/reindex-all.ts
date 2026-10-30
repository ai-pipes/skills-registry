import { indexSkill } from './index-skill.ts';
import type { SearchDeps } from './ports.ts';

/**
 * Rebuilds the index from the catalog and drops documents of vanished skills.
 * Returns the number of indexed (active) skills. An embedder failure does not stop the
 * run: every skill still gets its FTS row, then the first error is rethrown.
 */
export async function reindexAll(deps: SearchDeps): Promise<number> {
  const slugs = await deps.skills.listSlugs();
  const known = new Set(slugs);
  const stale = (await deps.index.slugs()).filter((s) => !known.has(s));
  await Promise.all(stale.map((slug) => deps.index.remove(slug)));
  // Sequential: one embedding call at a time.
  const failure = await slugs.reduce<Promise<unknown>>(async (prev, slug) => {
    const first = await prev;
    try {
      await indexSkill(deps, { slug });
    } catch (error) {
      return first ?? error;
    }
    return first;
  }, Promise.resolve(null));
  if (failure !== null) throw failure;
  return (await deps.index.slugs()).length;
}
