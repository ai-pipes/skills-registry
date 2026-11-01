import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { UsageError } from '../args.ts';
import type { CliEnv } from '../env.ts';
import { AGENTS } from '../install/agents.ts';

const SUPPORTED = 'claude-code';

/** The coding agent subagents are installed for; only Claude Code in v1. */
export function selectSubagentTarget(ids: string[], env: Pick<CliEnv, 'home'>): 'claude-code' {
  if (ids.length === 0) {
    if (existsSync(join(env.home, '.claude'))) return SUPPORTED;
    throw new UsageError(`no supported coding agent found; pass -a ${SUPPORTED}`);
  }
  for (const id of ids) {
    if (id === SUPPORTED || id === '*') continue;
    if (!AGENTS.some((a) => a.id === id)) {
      throw new UsageError(`unknown agent "${id}"; known: ${AGENTS.map((a) => a.id).join(', ')}`);
    }
    throw new UsageError(`${id} does not support subagents (supported: ${SUPPORTED})`);
  }
  return SUPPORTED;
}
