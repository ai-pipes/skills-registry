import { join, resolve } from 'node:path';
import type { CliEnv } from '../env.ts';
import type { Agent } from './agents.ts';

/** `fn` over `items` one after another (output stays in order), results in order. */
export function inSequence<T, R>(items: readonly T[], fn: (item: T) => Promise<R>): Promise<R[]> {
  return items.reduce<Promise<R[]>>(
    async (prev, item) => [...(await prev), await fn(item)],
    Promise.resolve([]),
  );
}

/** `fn` over `items` with at most `limit` running at once; results in order. */
export async function inParallel<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const out: R[] = Array.from({ length: items.length });
  const queue = items.entries();
  // Each worker takes the next item when its previous one is done.
  const worker = async (): Promise<void> => {
    const step = queue.next();
    if (step.done) return;
    const [i, item] = step.value;
    out[i] = await fn(item);
    return worker();
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

export type InstallPlan = { canonical: string; links: { agent: string; path: string }[] };

/**
 * Where a skill goes. `dir` → only `<dir>/<slug>` (relative to cwd). Otherwise the canonical copy
 * is `.agents/skills/<slug>` in cwd (or home with `global`), plus one link per agent whose skills
 * directory differs from the canonical one (agents sharing a directory share the link).
 */
export function planInstall(p: {
  slug: string;
  agents: readonly Agent[];
  global: boolean;
  dir: string | undefined;
  env: Pick<CliEnv, 'cwd' | 'home'>;
}): InstallPlan {
  if (p.dir !== undefined) return { canonical: resolve(p.env.cwd, p.dir, p.slug), links: [] };
  const base = p.global ? p.env.home : p.env.cwd;
  const canonical = join(base, '.agents/skills', p.slug);
  const links: InstallPlan['links'] = [];
  for (const a of p.agents) {
    const path = join(base, p.global ? a.global : a.project, p.slug);
    if (path !== canonical && !links.some((l) => l.path === path))
      links.push({ agent: a.id, path });
  }
  return { canonical, links };
}
