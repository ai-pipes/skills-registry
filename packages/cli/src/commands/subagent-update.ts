import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parse } from '../args.ts';
import type { Command } from '../env.ts';
import { inSequence } from '../install/layout.ts';
import { safe } from '../output.ts';
import { applyUpdate } from '../subagents/apply.ts';
import { inspectSubagent } from '../subagents/installed.ts';
import { openScope, type Scope } from '../subagents/scope.ts';
import { checkSlug } from './install.ts';

const options = {
  global: { type: 'boolean', short: 'g' },
  yes: { type: 'boolean' },
} as const;

async function updateOne(s: Scope, slug: string, yes: boolean): Promise<boolean> {
  const { env } = s;
  if (!Object.hasOwn(s.manifest.subagents, slug)) {
    env.err(`error: ${safe(slug)} is not installed`);
    return false;
  }
  const view = await s.client.getSubagent(slug);
  if (view === null) {
    env.err(`error: ${safe(slug)} is no longer in the registry`);
    return false;
  }
  if (view.status === 'archived') {
    env.err(`error: ${safe(slug)} is archived in the registry`);
    return false;
  }
  const path = join(s.dir, `${slug}.md`);
  const state = await inspectSubagent(s.dir, slug, s.server, s.manifest);
  if (state === 'absent') {
    env.err(`error: ${path} is missing; reinstall with install`);
    return false;
  }
  if (state === 'foreign') {
    env.err(
      `conflict: ${path} was not installed by skills-registry or was modified; reinstall with install --force`,
    );
    return false;
  }
  if (state.version === view.version) {
    env.out(`${safe(slug)} is up to date (v${view.version})`);
    return true;
  }
  const oldText = await readFile(path, 'utf8');
  return applyUpdate(s, slug, state, view, { yes, mcpServer: state.mcpServer, oldText });
}

/** `subagent update [<slug>...] [-g] [--yes]`: every installed subagent when no slug is given. */
export const subagentUpdate: Command = async (args, env) => {
  const { values, positionals } = parse(args, options, { min: 0, max: Infinity });
  const slugs = positionals.map((p) => checkSlug(p, 'subagent'));
  const s = await openScope(env, values.global ?? false);
  const targets = slugs.length > 0 ? slugs : Object.keys(s.manifest.subagents).toSorted();
  if (targets.length === 0) {
    env.out('no subagents installed');
    return 0;
  }
  const results = await inSequence(targets, async (slug) => {
    try {
      return await updateOne(s, slug, values.yes ?? false);
    } catch (e) {
      env.err(`error: ${safe(slug)}: ${safe(e instanceof Error ? e.message : String(e))}`);
      return false;
    }
  });
  return results.every(Boolean) ? 0 : 1;
};
