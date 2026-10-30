import { parse, UsageError } from '../args.ts';
import { requireConnection } from '../config.ts';
import type { Command } from '../env.ts';
import { RegistryClient } from '../registry.ts';
import { printSkills } from './list.ts';

const options = { folder: { type: 'string' } } as const;

/** `search <query> [--folder <slug>]`: active skills ranked by the registry's search. */
export const searchCommand: Command = async (args, env) => {
  const { values, positionals } = parse(args, options, { min: 1, max: Infinity });
  const q = positionals.join(' ').trim();
  if (q === '') throw new UsageError('missing search query');
  const client = new RegistryClient(await requireConnection(env), env.fetch);
  const folder = values.folder;
  printSkills(env, await client.listSkills(folder === undefined ? { q } : { q, folder }));
  return 0;
};
