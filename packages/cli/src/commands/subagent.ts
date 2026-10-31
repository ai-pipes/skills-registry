import { UsageError } from '../args.ts';
import type { Command } from '../env.ts';
import { subagentInstall } from './subagent-install.ts';
import { subagentList } from './subagent-list.ts';
import { subagentUninstall } from './subagent-uninstall.ts';
import { subagentUpdate } from './subagent-update.ts';

export const SUBAGENT_USAGE = `  subagent list [--folder <slug>] [--installed] [-g]
                                  list active subagents, or the installed ones with their state
  subagent install <slug>... [--folder <slug>] [-g] [-a claude-code] [--mcp-server <name>] [--force] [--yes]
                                  install subagents for Claude Code (.claude/agents)
  subagent update [<slug>...] [-g] [--yes]
                                  update installed subagents; --yes accepts changed tools
  subagent uninstall <slug>... [--folder <slug>] [-g] [-a claude-code]
                                  remove installed subagents`;

const SUBCOMMANDS: Record<string, Command> = {
  list: subagentList,
  install: subagentInstall,
  update: subagentUpdate,
  uninstall: subagentUninstall,
};

/** `subagent install | update | uninstall | list`. */
export const subagentCommand: Command = (args, env) => {
  const [name, ...rest] = args;
  if (name === '--help' || name === '-h' || name === 'help') {
    env.out(`usage: skills-registry subagent <command> [options]\n\n${SUBAGENT_USAGE}`);
    return Promise.resolve(0);
  }
  if (name === undefined) throw new UsageError('missing subagent command');
  const command = Object.hasOwn(SUBCOMMANDS, name) ? SUBCOMMANDS[name] : undefined;
  if (command === undefined) throw new UsageError(`unknown subagent command "${name}"`);
  return command(rest, env);
};
