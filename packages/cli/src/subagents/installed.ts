import { randomBytes } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { checkSlug } from '../commands/install.ts';
import type { CliEnv } from '../env.ts';
import { isNotFound } from '../fs-errors.ts';
import { sha256 } from '../manifest.ts';

/** The service file in an agents directory (no token in it). */
export const MANIFEST = '.skills-registry.json';

/** An MCP server name as Claude Code accepts it in `mcp__<name>__<tool>`. */
export const MCP_SERVER_RE = /^[A-Za-z0-9_-]+$/;

const Entry = z.object({
  server: z.string(),
  version: z.number().int().positive(),
  sha256: z.string(),
  mcpServer: z.string(),
  tools: z.array(z.string()).nullable(),
});
const ManifestFile = z.object({ subagents: z.record(z.string(), Entry) });

export type InstalledEntry = z.infer<typeof Entry>;
export type InstalledManifest = z.infer<typeof ManifestFile>;

/** `<cwd or home>/.claude/agents`. */
export function agentsDir(env: Pick<CliEnv, 'cwd' | 'home'>, global: boolean): string {
  return join(global ? env.home : env.cwd, '.claude', 'agents');
}

/** Writes `text` to `path` through a temporary file in the same directory, creating it. */
async function writeAtomic(dir: string, name: string, text: string): Promise<void> {
  await mkdir(dir, { recursive: true });
  const tmp = join(dir, `.${name}.${randomBytes(6).toString('hex')}.tmp`);
  try {
    await writeFile(tmp, text);
    await rename(tmp, join(dir, name));
  } catch (e) {
    await rm(tmp, { force: true });
    throw e;
  }
}

/** The manifest of `dir`; empty when it is missing or not valid. */
export async function readInstalled(dir: string): Promise<InstalledManifest> {
  try {
    const parsed = ManifestFile.safeParse(JSON.parse(await readFile(join(dir, MANIFEST), 'utf8')));
    return parsed.success ? parsed.data : { subagents: {} };
  } catch {
    return { subagents: {} };
  }
}

export function writeInstalled(dir: string, m: InstalledManifest): Promise<void> {
  return writeAtomic(dir, MANIFEST, `${JSON.stringify(m, null, 2)}\n`);
}

export async function writeSubagentFile(dir: string, slug: string, text: string): Promise<void> {
  await writeAtomic(dir, `${checkSlug(slug, 'subagent')}.md`, text);
}

/** Ours: an entry from `server` whose sha256 equals the file's. Anything else there is foreign. */
export async function inspectSubagent(
  dir: string,
  slug: string,
  server: string,
  m: InstalledManifest,
): Promise<'absent' | 'foreign' | InstalledEntry> {
  let bytes: Buffer;
  try {
    bytes = await readFile(join(dir, `${checkSlug(slug, 'subagent')}.md`));
  } catch (e) {
    if (isNotFound(e)) return 'absent';
    throw e;
  }
  const entry = Object.hasOwn(m.subagents, slug) ? m.subagents[slug] : undefined;
  if (entry === undefined || entry.server !== server) return 'foreign';
  return entry.sha256 === sha256(bytes) ? entry : 'foreign';
}
