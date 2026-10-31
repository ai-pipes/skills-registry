import { UsageError } from '../args.ts';
import { requireConnection } from '../config.ts';
import type { CliEnv } from '../env.ts';
import { RegistryClient } from '../registry.ts';
import { agentsDir, type InstalledManifest, MCP_SERVER_RE, readInstalled } from './installed.ts';

/** What every `subagent` command works on: one agents directory and the registry. */
export type Scope = {
  env: CliEnv;
  client: RegistryClient;
  server: string;
  dir: string;
  /** The manifest of `dir`, kept in step with the files by the commands. */
  manifest: InstalledManifest;
};

export async function openScope(env: CliEnv, global: boolean): Promise<Scope> {
  const conn = await requireConnection(env);
  const dir = agentsDir(env, global);
  return {
    env,
    client: new RegistryClient(conn, env.fetch),
    server: conn.url.replace(/\/+$/, ''),
    dir,
    manifest: await readInstalled(dir),
  };
}

/** A name the user connected the registry's MCP server under; anything else is a usage error. */
export function checkMcpServer(name: string): string {
  if (!MCP_SERVER_RE.test(name)) throw new UsageError(`invalid --mcp-server "${name}"`);
  return name;
}
