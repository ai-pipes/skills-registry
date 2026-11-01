import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { parse, UsageError } from '../args.ts';
import type { Command } from '../env.ts';
import { inSequence } from '../install/layout.ts';
import { safe } from '../output.ts';
import { inspectSubagent, writeInstalled } from '../subagents/installed.ts';
import { openScope, type Scope } from '../subagents/scope.ts';
import { selectSubagentTarget } from '../subagents/target.ts';
import { checkSlug } from './install.ts';

const options = {
  global: { type: 'boolean', short: 'g' },
  agent: { type: 'string', short: 'a', multiple: true },
  folder: { type: 'string' },
} as const;

/** Removes our install of `slug`; `false` when the file there is not ours. */
async function uninstallOne(s: Scope, slug: string): Promise<boolean> {
  const path = join(s.dir, `${slug}.md`);
  const state = await inspectSubagent(s.dir, slug, s.server, s.manifest);
  if (state === 'foreign') {
    s.env.err(`skipped ${path}: not installed by skills-registry`);
    return false;
  }
  if (state === 'absent') s.env.out(`${safe(slug)} is not installed`);
  else {
    await rm(path, { force: true });
    s.env.out(`removed ${path}`);
  }
  if (Object.hasOwn(s.manifest.subagents, slug)) {
    delete s.manifest.subagents[slug];
    await writeInstalled(s.dir, s.manifest);
  }
  return true;
}

/**
 * `subagent uninstall <slug>... [--folder <slug>] [-g] [-a claude-code]`: removes only what
 * skills-registry installed. `--folder` adds the installed subagents the registry lists there.
 */
export const subagentUninstall: Command = async (args, env) => {
  const { values, positionals } = parse(args, options, { min: 0, max: Infinity });
  const slugs = positionals.map((p) => checkSlug(p, 'subagent'));
  if (slugs.length === 0 && values.folder === undefined) throw new UsageError('missing argument');
  selectSubagentTarget(values.agent ?? [], env);
  const s = await openScope(env, values.global ?? false);
  if (values.folder !== undefined) {
    const inFolder = await s.client.listSubagents({ folder: values.folder, status: 'all' });
    slugs.push(
      ...inFolder.map((a) => a.slug).filter((slug) => Object.hasOwn(s.manifest.subagents, slug)),
    );
  }
  const results = await inSequence([...new Set(slugs)], async (slug) => {
    try {
      return await uninstallOne(s, slug);
    } catch (e) {
      env.err(`error: ${safe(slug)}: ${safe(e instanceof Error ? e.message : String(e))}`);
      return false;
    }
  });
  return results.every(Boolean) ? 0 : 1;
};
