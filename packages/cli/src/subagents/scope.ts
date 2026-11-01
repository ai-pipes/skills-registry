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

/** The registry connection alone, for commands that never touch the local manifest. */
export async function openClient(env: CliEnv): Promise<{ client: RegistryClient; server: string }> {
  const conn = await requireConnection(env);
  return { client: new RegistryClient(conn, env.fetch), server: conn.url.replace(/\/+$/, '') };
}

export async function openScope(env: CliEnv, global: boolean): Promise<Scope> {
  const { client, server } = await openClient(env);
  const dir = agentsDir(env, global);
  return { env, client, server, dir, manifest: await readInstalled(dir) };
}

/** A name the user connected the registry's MCP server under; anything else is a usage error. */
export function checkMcpServer(name: string): string {
  if (!MCP_SERVER_RE.test(name)) throw new UsageError(`invalid --mcp-server "${name}"`);
  return name;
}
