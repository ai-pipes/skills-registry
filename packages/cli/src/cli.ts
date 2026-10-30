import { UsageError } from './args.ts';
import { importCommand } from './commands/import.ts';
import { installCommand } from './commands/install.ts';
import { listCommand } from './commands/list.ts';
import { loginCommand } from './commands/login.ts';
import { logoutCommand } from './commands/logout.ts';
import { searchCommand } from './commands/search.ts';
import { uninstallCommand } from './commands/uninstall.ts';
import { updateCommand } from './commands/update.ts';
import type { CliEnv, Command } from './env.ts';
import { safe } from './output.ts';

const USAGE = `usage: skills-registry <command> [options]

  login <url>                     save the server and an API token (read from stdin)
  logout                          forget the saved server and token
  list [--folder <slug>]          list active skills
  search <query> [--folder <slug>]
                                  search active skills
  import <source> [--skill <name>]... [--folder <slug>] [--ref <ref>] [--dry-run]
                                  import skills from a public GitHub repository
  update <slug> [<source>] [--dry-run]
                                  update an imported skill from its GitHub source
  install <slug>[@<version>]... [-g] [-a <agent>]... [--copy] [--dir <path>] [--force]
                                  install skills for coding agents
  uninstall <slug>... [-g] [-a <agent>]... [--dir <path>]
                                  remove installed skills

  <source>: owner/repo or https://github.com/owner/repo[/tree/<ref>/<path>]

environment:
  SKILLS_REGISTRY_URL, SKILLS_REGISTRY_TOKEN   override the saved login
  GITHUB_TOKEN                                 GitHub API token (optional)
  GITHUB_API_URL                               default https://api.github.com`;

const COMMANDS: Record<string, Command> = {
  login: loginCommand,
  logout: logoutCommand,
  list: listCommand,
  search: searchCommand,
  import: importCommand,
  update: updateCommand,
  install: installCommand,
  uninstall: uninstallCommand,
};

/** Runs one command. Exit codes: 0 success, 1 the operation failed, 2 wrong invocation. */
export async function runCli(argv: string[], env: CliEnv): Promise<number> {
  const [name, ...args] = argv;
  if (name === undefined || name === 'help' || name === '--help' || name === '-h') {
    env.out(USAGE);
    return 0;
  }
  const command = Object.hasOwn(COMMANDS, name) ? COMMANDS[name] : undefined;
  if (command === undefined) {
    env.err(`error: unknown command "${name}"`);
    env.err(USAGE);
    return 2;
  }
  try {
    return await command(args, env);
  } catch (e) {
    if (e instanceof UsageError) {
      env.err(`error: ${e.message}`);
      env.err(USAGE);
      return 2;
    }
    // Messages may carry server or GitHub text.
    env.err(`error: ${safe(e instanceof Error ? e.message : String(e))}`);
    return 1;
  }
}
