import { rm } from 'node:fs/promises';
import { parse } from '../args.ts';
import type { CliEnv, Command } from '../env.ts';
import { AGENTS, type Agent, selectAgents } from '../install/agents.ts';
import { inSequence, planInstall } from '../install/layout.ts';
import { inspectDir, inspectLink } from '../install/marker.ts';
import { checkSlug } from './install.ts';

const options = {
  global: { type: 'boolean', short: 'g' },
  agent: { type: 'string', short: 'a', multiple: true },
  dir: { type: 'string' },
} as const;

/** Removes our installs of `slug`; `false` when something there was not ours. */
async function uninstallOne(
  env: CliEnv,
  slug: string,
  agents: readonly Agent[],
  o: { global: boolean; dir: string | undefined },
): Promise<boolean> {
  const plan = planInstall({ slug, agents, global: o.global, dir: o.dir, env });
  const want = { slug };
  const found = [
    ...(await Promise.all(
      plan.links.map(async (l) => {
        const state = await inspectLink(l.path, plan.canonical, want);
        return { path: l.path, present: state !== 'absent', ours: state !== 'foreign' };
      }),
    )),
    await inspectDir(plan.canonical, want).then((s) => ({
      path: plan.canonical,
      present: s !== 'absent',
      ours: s !== 'foreign',
    })),
  ].filter((e) => e.present);
  if (found.length === 0) {
    env.out(`${slug} is not installed`);
    return true;
  }
  await Promise.all(
    found.filter((e) => e.ours).map((e) => rm(e.path, { recursive: true, force: true })),
  );
  for (const e of found) {
    if (e.ours) env.out(`removed ${e.path}`);
    else env.err(`skipped ${e.path}: not installed by skills-registry`);
  }
  return found.every((e) => e.ours);
}

/**
 * `uninstall <slug>... [-g] [-a <agent>]... [--dir <path>]`: removes the agents' links (or copies)
 * and the canonical copy, but only what skills-registry installed. Without `-a` every known
 * agent is checked (only our own links are removed). Exit 1 when something was skipped.
 */
export const uninstallCommand: Command = async (args, env) => {
  const { values, positionals } = parse(args, options, { min: 1, max: Infinity });
  const slugs = positionals.map(checkSlug);
  const agents = values.agent === undefined ? AGENTS : selectAgents(values.agent, env);
  const o = { global: values.global ?? false, dir: values.dir };
  const results = await inSequence(slugs, (slug) => uninstallOne(env, slug, agents, o));
  return results.every(Boolean) ? 0 : 1;
};
