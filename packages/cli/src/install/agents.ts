import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { UsageError } from '../args.ts';
import type { CliEnv } from '../env.ts';

/**
 * A coding agent: its skills directory in a project (relative to cwd) and globally (relative to
 * home), and the home directory whose presence means the agent is installed. Checked against
 * `vercel-labs/skills` `docs/agents.md`; a new agent is a new row.
 */
export type Agent = { id: string; project: string; global: string; detect: string };

const row = (id: string, project: string, global: string, detect: string): Agent => ({
  id,
  project,
  global,
  detect,
});

export const AGENTS: readonly Agent[] = [
  row('claude-code', '.claude/skills', '.claude/skills', '.claude'),
  row('codex', '.agents/skills', '.agents/skills', '.codex'),
  row('cursor', '.agents/skills', '.cursor/skills', '.cursor'),
  row('gemini-cli', '.agents/skills', '.gemini/skills', '.gemini'),
  row('github-copilot', '.agents/skills', '.copilot/skills', '.copilot'),
  row('opencode', '.agents/skills', '.config/opencode/skills', '.config/opencode'),
  row('cline', '.agents/skills', '.agents/skills', '.cline'),
  row('windsurf', '.windsurf/skills', '.codeium/windsurf/skills', '.codeium/windsurf'),
  row('goose', '.goose/skills', '.config/goose/skills', '.config/goose'),
  row('amp', '.agents/skills', '.config/agents/skills', '.config/amp'),
  row('roo', '.roo/skills', '.roo/skills', '.roo'),
];

/** `[]` → the agents found by `home/detect`; `['*']` → all; an unknown id is a usage error. */
export function selectAgents(ids: string[], env: Pick<CliEnv, 'home'>): Agent[] {
  if (ids.length === 0) return AGENTS.filter((a) => existsSync(join(env.home, a.detect)));
  if (ids.includes('*')) return [...AGENTS];
  const picked: Agent[] = [];
  for (const id of ids) {
    const a = AGENTS.find((x) => x.id === id);
    if (a === undefined) {
      throw new UsageError(`unknown agent "${id}"; known: ${AGENTS.map((x) => x.id).join(', ')}`);
    }
    if (!picked.includes(a)) picked.push(a);
  }
  return picked;
}
