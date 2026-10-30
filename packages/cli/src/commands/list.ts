import type { SkillSummary } from '@skills/contracts';
import { parse } from '../args.ts';
import { requireConnection } from '../config.ts';
import type { CliEnv, Command } from '../env.ts';
import { safe } from '../output.ts';
import { RegistryClient } from '../registry.ts';

const options = { folder: { type: 'string' } } as const;

/** One skill per line: `<slug>\tv<version>\t<folder>\t<description>` (control characters → `?`). */
export function printSkills(env: CliEnv, skills: SkillSummary[]): void {
  for (const s of skills) {
    env.out(`${safe(s.slug)}\tv${s.version}\t${safe(s.folder.slug)}\t${safe(s.description)}`);
  }
}

/** `list [--folder <slug>]`: active skills. */
export const listCommand: Command = async (args, env) => {
  const { values } = parse(args, options, { min: 0, max: 0 });
  const client = new RegistryClient(await requireConnection(env), env.fetch);
  const folder = values.folder;
  printSkills(env, await client.listSkills(folder === undefined ? {} : { folder }));
  return 0;
};
