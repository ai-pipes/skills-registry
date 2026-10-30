import { indexSkill } from './index-skill.ts';
import type { SearchDeps } from './ports.ts';

/** Consecutive failures that make the sweep treat the embedder as down and stop. */
const OUTAGE_STREAK = 3;
/** Known-good passage: tells a poison streak from an embedder outage. */
const PROBE_TEXT = 'passage: health probe';
/** Wall-clock budget of one sweep, well under the 60 s outbox lease. */
const SWEEP_BUDGET_MS = 30_000;

export type SweepResult = {
  indexed: string[];
  /** Slugs whose embedding failed (marked or not). Slugs only, never content. */
  failed: string[];
  stoppedEarly: 'outage' | 'budget' | null;
};

/**
 * Recovery sweep: re-indexes up to `limit` documents whose embedding is null, e.g. after an
 * embedder outage outlasted the outbox retries. Does nothing until the embedder is ready.
 * Sequential. A failure is an isolated "poison document" only if a later document succeeds;
 * then it is marked (`embed_failed_at`) and skipped for an hour. After a streak of
 * OUTAGE_STREAK failures a known-good probe passage is embedded: if it succeeds the streak is
 * poison (all marked, sweep continues); if it fails the embedder is down (sweep stops, nothing
 * marked). The sweep also stops when the wall-clock budget is spent. Documents not attempted
 * are never marked.
 */
export async function indexMissingEmbeddings(
  deps: SearchDeps,
  opts: { limit: number; budgetMs?: number; now?: () => number },
): Promise<SweepResult> {
  const result: SweepResult = { indexed: [], failed: [], stoppedEarly: null };
  if (!(await deps.embedder.ready())) return result;
  const now = opts.now ?? Date.now;
  const deadline = now() + (opts.budgetMs ?? SWEEP_BUDGET_MS);
  const slugs = await deps.index.slugsWithoutEmbedding(opts.limit);
  // Failures since the last success; marked only once a later document succeeds.
  let streak: string[] = [];
  await slugs.reduce(async (prev, slug) => {
    await prev;
    if (result.stoppedEarly !== null) return;
    if (now() >= deadline) {
      result.stoppedEarly = 'budget';
      return;
    }
    try {
      await indexSkill(deps, { slug });
      result.indexed.push(slug);
      const isolated = streak;
      streak = [];
      await Promise.all(isolated.map((s) => deps.index.markEmbedFailed(s)));
    } catch {
      result.failed.push(slug);
      streak.push(slug);
      if (streak.length >= OUTAGE_STREAK) {
        const healthy = await deps.embedder.embedPassages([PROBE_TEXT]).then(
          () => true,
          () => false,
        );
        if (healthy) {
          const poison = streak;
          streak = [];
          await Promise.all(poison.map((s) => deps.index.markEmbedFailed(s)));
        } else {
          result.stoppedEarly = 'outage';
        }
      }
    }
  }, Promise.resolve());
  return result;
}
