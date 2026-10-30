import { rrf } from '../domain/rrf.ts';
import { MAX_PASSAGE_CHARS } from '../domain/search-document.ts';
import type { SearchDeps } from './ports.ts';

const CANDIDATES = 50;
const RRF_K = 60;
/** FTS and vector: the number of lists a perfect hit tops. */
const LISTS = 2;

/**
 * Default τ, tuned on multilingual-e5-small (ADR 0005): unrelated queries mostly stay below
 * 0.79, relevant ones mostly reach 0.81.
 */
export const DEFAULT_MIN_SIMILARITY = 0.8;

/** `folder` is the folder slug. */
export type SearchHit = {
  slug: string;
  name: string;
  description: string;
  folder: string;
  score: number;
};

/** Vector candidates, or null when the embedder is not ready, fails, or the query is too long. */
async function vectorCandidates(
  deps: Pick<SearchDeps, 'index' | 'embedder' | 'minSimilarity'>,
  query: string,
  folders: string[] | null,
): Promise<string[] | null> {
  if (query.length > MAX_PASSAGE_CHARS) return null;
  try {
    if (!(await deps.embedder.ready())) return null;
    const embedding = await deps.embedder.embedQuery(query);
    return await deps.index.vectorCandidates(embedding, CANDIDATES, deps.minSimilarity, folders);
  } catch {
    return null;
  }
}

/**
 * Hybrid search: FTS and vector candidates (similarity ≥ τ) fused with RRF; works FTS-only
 * without embeddings. Nothing matches the text and nothing clears τ → [].
 *
 * score = rrf / (2 / (k + 1)): the share of the best possible fused score over the two lists
 * (FTS and vector). The divisor is fixed, so a hit's score does not depend on whether the
 * embedder was ready: 1 = first in both lists; a hit found by one list scores at most 0.5.
 * The score is never rescaled to the best hit.
 *
 * `folders` (slugs) restricts both candidate lists in the same query, before the top-N cut;
 * omitted → every folder, `[]` → nothing.
 */
export async function searchSkills(
  deps: Pick<SearchDeps, 'index' | 'embedder' | 'minSimilarity'>,
  q: { query: string; limit: number; folders?: string[] },
): Promise<SearchHit[]> {
  const query = q.query.trim();
  const folders = q.folders ?? null;
  if (query.length === 0 || q.limit <= 0 || folders?.length === 0) return [];
  const [fts, vector] = await Promise.all([
    deps.index.ftsCandidates(query, CANDIDATES, folders),
    vectorCandidates(deps, query, folders),
  ]);
  const lists = vector ? [fts, vector] : [fts];
  const fused = rrf(lists, RRF_K).slice(0, q.limit);
  const docs = new Map(
    (await deps.index.summaries(fused.map((f) => f.id))).map((d) => [d.slug, d]),
  );
  const maxScore = LISTS / (RRF_K + 1);
  return fused.flatMap((f) => {
    const doc = docs.get(f.id);
    return doc ? [{ ...doc, score: f.score / maxScore }] : [];
  });
}
