import { chmod, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { z } from 'zod';
import { UsageError } from './args.ts';
import type { CliEnv } from './env.ts';
import { isNotFound } from './fs-errors.ts';

/** Where and how the CLI talks to a registry. The token is a secret: never printed. */
export type Connection = { url: string; token: string };

const ConfigFile = z.object({ url: z.string(), token: z.string() });

/** `${XDG_CONFIG_HOME:-~/.config}/skills-registry/config.json`. */
function configPath(env: CliEnv): string {
  const base = env.vars.XDG_CONFIG_HOME || join(env.home, '.config');
  return join(base, 'skills-registry', 'config.json');
}

/**
 * `SKILLS_REGISTRY_URL` + `SKILLS_REGISTRY_TOKEN` (both set) win over the config file; only one of
 * them set is a usage error.
 */
export async function loadConnection(env: CliEnv): Promise<Connection | null> {
  const url = env.vars.SKILLS_REGISTRY_URL;
  const token = env.vars.SKILLS_REGISTRY_TOKEN;
  if (url && token) return { url, token };
  if (url || token) {
    throw new UsageError('set both SKILLS_REGISTRY_URL and SKILLS_REGISTRY_TOKEN, or neither');
  }
  const path = configPath(env);
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch (e) {
    if (isNotFound(e)) return null;
    throw e;
  }
  let parsed;
  try {
    parsed = ConfigFile.safeParse(JSON.parse(text));
  } catch {
    parsed = undefined;
  }
  if (!parsed?.success) throw new Error(`invalid config file ${path}; run login again`);
  return parsed.data;
}

/** Writes the config: directory `0700`, file `0600` (also when they already existed). */
export async function saveConnection(env: CliEnv, c: Connection): Promise<void> {
  const path = configPath(env);
  const dir = dirname(path);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await chmod(dir, 0o700);
  await writeFile(path, `${JSON.stringify({ url: c.url, token: c.token }, null, 2)}\n`, {
    mode: 0o600,
  });
  await chmod(path, 0o600);
}

/** Removes the config file; `false` if there was none. */
export async function deleteConnection(env: CliEnv): Promise<boolean> {
  try {
    await rm(configPath(env));
    return true;
  } catch (e) {
    if (isNotFound(e)) return false;
    throw e;
  }
}

export async function requireConnection(env: CliEnv): Promise<Connection> {
  const c = await loadConnection(env);
  if (c === null) throw new UsageError('not logged in: run skills-registry login <url>');
  return c;
}
