/**
 * Reciprocal Rank Fusion: score(id) = Σ over lists of 1 / (k + rank), rank 1-based.
 * An id counts once per list (its best rank). Ties keep first-seen order.
 */
export function rrf(lists: string[][], k: number): { id: string; score: number }[] {
  const scores = new Map<string, number>();
  for (const list of lists) {
    const seen = new Set<string>();
    list.forEach((id, i) => {
      if (seen.has(id)) return;
      seen.add(id);
      scores.set(id, (scores.get(id) ?? 0) + 1 / (k + i + 1));
    });
  }
  return [...scores].map(([id, score]) => ({ id, score })).toSorted((a, b) => b.score - a.score);
}
