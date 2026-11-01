import { parse, UsageError } from '../args.ts';
import type { Command } from '../env.ts';
import { safe } from '../output.ts';
import { inspectSubagent } from '../subagents/installed.ts';
import { openClient, openScope } from '../subagents/scope.ts';

const options = {
  global: { type: 'boolean', short: 'g' },
  folder: { type: 'string' },
  installed: { type: 'boolean' },
} as const;

/**
 * `subagent list [--folder <slug>]`: active subagents, `<slug>\tv<version>\t<folder>\t<description>`.
 * `subagent list --installed [-g]`: `<slug>\tv<installed>\t<latest>\t<state>` for what is installed
 * here; the state is ok, modified (the file is not ours), deleted (no file), archived or missing
 * (gone from the registry).
 */
export const subagentList: Command = async (args, env) => {
  const { values } = parse(args, options, { min: 0, max: 0 });
  if (values.installed === true && values.folder !== undefined) {
    throw new UsageError('--folder cannot be combined with --installed');
  }
  if (values.installed !== true) {
    const { client } = await openClient(env);
    const agents = await client.listSubagents(
      values.folder === undefined ? {} : { folder: values.folder },
    );
    for (const a of agents) {
      env.out(`${safe(a.slug)}\tv${a.version}\t${safe(a.folder.slug)}\t${safe(a.description)}`);
    }
    return 0;
  }
  const s = await openScope(env, values.global ?? false);
  const registry = new Map(
    (await s.client.listSubagents({ status: 'all' })).map((a) => [a.slug, a]),
  );
  const rows = await Promise.all(
    Object.entries(s.manifest.subagents)
      .toSorted(([a], [b]) => (a < b ? -1 : 1))
      .map(async ([slug, entry]) => {
        const latest = registry.get(slug);
        const file = await inspectSubagent(s.dir, slug, s.server, s.manifest);
        let state = 'ok';
        if (latest === undefined) state = 'missing';
        else if (latest.status === 'archived') state = 'archived';
        else if (file === 'foreign') state = 'modified';
        else if (file === 'absent') state = 'deleted';
        const newest =
          latest === undefined
            ? '-'
            : `v${latest.version}${latest.version > entry.version ? ' ↑' : ''}`;
        return `${safe(slug)}\tv${entry.version}\t${newest}\t${state}`;
      }),
  );
  for (const row of rows) env.out(row);
  return 0;
};
