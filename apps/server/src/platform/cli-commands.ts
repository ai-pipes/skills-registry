import { parseArgs } from 'node:util';
import {
  actAs,
  createToken,
  linkSso,
  provisionUser,
  unlinkSso,
} from '../modules/identity/index.ts';
import { connectCommand } from '../modules/identity/interfaces/http/tokens.ts';
import { reindexAll } from '../modules/search/index.ts';
import { DomainError } from '../shared-kernel/index.ts';
import type { Container } from './container.ts';

export type CliIo = {
  readStdin(): Promise<string>;
  out(line: string): void;
  err(line: string): void;
};

const USAGE = `Usage: node dist/cli.js <command>

  reindex
      Rebuild the search index for every skill.
  create-user <login> --role admin|member
      Create a user; the password is read from stdin.
  create-token <login> --name <name>
      Create an API token for <login>; prints the token and the claude mcp add command.
  link-sso <login> <sub>
      Link <login> to the identity provider account <sub>: single sign-on then lands on this
      user, keeping its id, tokens and authorship.
  unlink-sso <login>
      Remove the link to the identity provider; API tokens keep working.`;

/** Bad invocation: printed with the usage, exit code 2. */
class UsageError extends Error {}

type Command = (args: string[], c: Container, io: CliIo) => Promise<number>;

function parse(args: string[], options: Record<string, { type: 'string' }>, positionals: number) {
  let parsed;
  try {
    parsed = parseArgs({ args, options, allowPositionals: true, strict: true });
  } catch (error) {
    throw new UsageError(error instanceof Error ? error.message : String(error));
  }
  if (parsed.positionals.length !== positionals) {
    throw new UsageError(`expected ${positionals} argument(s), got ${parsed.positionals.length}`);
  }
  return { values: parsed.values, positionals: parsed.positionals };
}

function required(values: Record<string, unknown>, name: string): string {
  const v = values[name];
  if (typeof v !== 'string' || v === '') throw new UsageError(`--${name} is required`);
  return v;
}

function oneOf<T extends string>(value: string, allowed: readonly T[], name: string): T {
  const found = allowed.find((a) => a === value);
  if (found === undefined) throw new UsageError(`--${name} must be one of ${allowed.join(', ')}`);
  return found;
}

/** Strips one trailing newline (what `echo` or a heredoc adds), nothing else. */
const stripNewline = (s: string): string => s.replace(/\r?\n$/, '');

const reindexCommand: Command = async (args, c, io) => {
  parse(args, {}, 0);
  const count = await reindexAll(c.search);
  io.out(`reindexed ${count} skills`);
  return 0;
};

const createUserCommand: Command = async (args, c, io) => {
  const { values, positionals } = parse(args, { role: { type: 'string' } }, 1);
  const role = oneOf(required(values, 'role'), ['admin', 'member'] as const, 'role');
  const password = stripNewline(await io.readStdin());
  const login = positionals[0] ?? '';
  const r = await provisionUser(c.identity, { login, password, role });
  if (!r.ok) throw r.error;
  io.out(`created ${role} "${login.trim()}" (${r.value.id})`);
  return 0;
};

const createTokenCommand: Command = async (args, c, io) => {
  const { values, positionals } = parse(args, { name: { type: 'string' } }, 1);
  const name = required(values, 'name');
  const actor = await actAs(c.identity, positionals[0] ?? '');
  if (!actor.ok) throw actor.error;
  const t = await createToken(c.identity, { principal: actor.value, name });
  io.out(t.token);
  io.out(connectCommand(c.config.publicUrl, t.token));
  io.err('The token is shown only once; store it now.');
  return 0;
};

const linkSsoCommand: Command = async (args, c, io) => {
  const { positionals } = parse(args, {}, 2);
  const [login = '', sub = ''] = positionals;
  if (sub.trim() === '') throw new UsageError('<sub> must not be empty');
  const r = await linkSso(c.identity, { login, sub });
  if (!r.ok) throw r.error;
  io.out(r.value.changed ? `linked "${login.trim()}" to ${sub.trim()}` : 'already linked');
  return 0;
};

const unlinkSsoCommand: Command = async (args, c, io) => {
  const { positionals } = parse(args, {}, 1);
  const login = positionals[0] ?? '';
  const r = await unlinkSso(c.identity, { login });
  if (!r.ok) throw r.error;
  io.out(r.value.changed ? `unlinked "${login.trim()}"` : 'not linked');
  return 0;
};

const COMMANDS: Record<string, Command> = {
  reindex: reindexCommand,
  'create-user': createUserCommand,
  'create-token': createTokenCommand,
  'link-sso': linkSsoCommand,
  'unlink-sso': unlinkSsoCommand,
};

/**
 * Runs one CLI command against an already built container. Returns the exit code:
 * 0 success, 1 the operation failed, 2 bad invocation (usage printed to `err`).
 */
export async function runCli(argv: string[], c: Container, io: CliIo): Promise<number> {
  const [name = '', ...args] = argv;
  const command = COMMANDS[name];
  try {
    if (!command)
      throw new UsageError(name === '' ? 'no command given' : `unknown command "${name}"`);
    return await command(args, c, io);
  } catch (error) {
    if (error instanceof UsageError) {
      io.err(`error: ${error.message}`);
      io.err(USAGE);
      return 2;
    }
    if (error instanceof DomainError) {
      io.err(`error: ${error.code}: ${error.message}`);
      return 1;
    }
    throw error;
  }
}
