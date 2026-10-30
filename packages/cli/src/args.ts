import { parseArgs, type ParseArgsOptionsConfig } from 'node:util';

/** A wrong invocation: `runCli` prints the message and the usage, exit code 2. */
export class UsageError extends Error {
  override name = 'UsageError';
}

/**
 * Strict `parseArgs` over a command's arguments: unknown options, missing option values and a
 * positional count outside `[min, max]` are `UsageError`s.
 */
export function parse<const T extends ParseArgsOptionsConfig>(
  args: string[],
  options: T,
  count: { min: number; max: number },
) {
  let parsed;
  try {
    parsed = parseArgs({ args, options, strict: true, allowPositionals: true });
  } catch (e) {
    throw new UsageError(e instanceof Error ? e.message : String(e));
  }
  const n = parsed.positionals.length;
  if (n < count.min) throw new UsageError('missing argument');
  if (n > count.max) throw new UsageError(`unexpected argument "${parsed.positionals[count.max]}"`);
  return parsed;
}
