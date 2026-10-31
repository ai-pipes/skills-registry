import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { UsageError } from '../args.ts';
import type { CliEnv } from '../env.ts';
import { AGENTS, selectAgents } from '../install/agents.ts';

const SUPPORTED = 'claude-code';

/** The coding agent subagents are installed for; only Claude Code in v1. */
export function selectSubagentTarget(ids: string[], env: Pick<CliEnv, 'home'>): 'claude-code' {
  if (ids.length === 0) {
    if (existsSync(join(env.home, '.claude'))) return SUPPORTED;
    throw new UsageError(`no supported coding agent found; pass -a ${SUPPORTED}`);
  }
  for (const id of ids) {
    if (id === SUPPORTED || id === '*') continue;
    selectAgents([id], env); // an unknown id throws the shared message
    if (AGENTS.some((a) => a.id === id)) {
      throw new UsageError(`${id} does not support subagents (supported: ${SUPPORTED})`);
    }
  }
  return SUPPORTED;
}
