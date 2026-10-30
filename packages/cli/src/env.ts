/**
 * Every external effect of the CLI except the file system under `home`/`cwd`: network, output,
 * secret input, environment variables. Commands take it as a parameter, so unit tests inject
 * fakes (see test/fake-env.ts) and never touch the network or the real home directory.
 */
export type CliEnv = {
  fetch: typeof fetch;
  out(line: string): void;
  err(line: string): void;
  readSecret(prompt: string): Promise<string>;
  vars: Record<string, string | undefined>;
  home: string;
  cwd: string;
  platform: NodeJS.Platform;
};

/** A subcommand: its arguments (without the command name) → exit code (0 ok, 1 failed, 2 usage). */
export type Command = (args: string[], env: CliEnv) => Promise<number>;
