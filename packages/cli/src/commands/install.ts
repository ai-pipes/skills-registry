import { rm } from 'node:fs/promises';
import { parse, UsageError } from '../args.ts';
import { requireConnection } from '../config.ts';
import type { CliEnv, Command } from '../env.ts';
import { selectAgents } from '../install/agents.ts';
import { inParallel, inSequence, planInstall } from '../install/layout.ts';
import { inspectDir, inspectLink } from '../install/marker.ts';
import { checkPath, linkOrCopy, writeSkillDir } from '../install/write.ts';
import { manifestOf, sha256 } from '../manifest.ts';
import { safe } from '../output.ts';
import { RegistryClient } from '../registry.ts';

const options = {
  global: { type: 'boolean', short: 'g' },
  agent: { type: 'string', short: 'a', multiple: true },
  copy: { type: 'boolean' },
  dir: { type: 'string' },
  force: { type: 'boolean' },
} as const;

/** Files downloaded at once. */
const DOWNLOADS = 8;

const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** A kebab-case slug (it becomes a directory name); anything else is a usage error. */
export function checkSlug(slug: string): string {
  if (!SLUG.test(slug)) throw new UsageError(`invalid skill slug "${slug}"`);
  return slug;
}

function parseTarget(arg: string): { slug: string; version: number | undefined } {
  const at = arg.lastIndexOf('@');
  if (at < 0) return { slug: checkSlug(arg), version: undefined };
  const v = arg.slice(at + 1);
  if (!/^[1-9]\d{0,8}$/.test(v)) throw new UsageError(`invalid version in "${arg}"`);
  return { slug: checkSlug(arg.slice(0, at)), version: Number(v) };
}

const conflict = (env: CliEnv, path: string) =>
  env.err(`conflict: ${path} was not installed by skills-registry or was modified; use --force`);

type Opts = { global: boolean; copy: boolean; force: boolean; dir: string | undefined };

async function installOne(
  env: CliEnv,
  client: RegistryClient,
  server: string,
  agents: ReturnType<typeof selectAgents>,
  target: { slug: string; version: number | undefined },
  o: Opts,
): Promise<boolean> {
  const { slug, version } = target;
  const plan = planInstall({ slug, agents, global: o.global, dir: o.dir, env });
  const view = await client.getSkill(slug, version);
  if (view === null) {
    env.err(`error: ${version === undefined ? `skill ${slug}` : `${slug} v${version}`} not found`);
    return false;
  }
  // `view.files` lists every file but SKILL.md (shown separately); the manifest has them all.
  const manifest = [...manifestOf(view)];
  for (const [path] of manifest) checkPath(path);

  const want = { slug, server };
  const installed = await inspectDir(plan.canonical, want);
  const links = await Promise.all(
    plan.links.map(async (l) => ({ ...l, state: await inspectLink(l.path, plan.canonical, want) })),
  );
  if (!o.force) {
    const clashes = [
      ...(installed === 'foreign' ? [plan.canonical] : []),
      ...links.filter((l) => l.state === 'foreign').map((l) => l.path),
    ];
    for (const p of clashes) conflict(env, p);
    if (clashes.length > 0) return false;
  }

  const current = typeof installed === 'object' && installed.version === view.version;
  if (current) {
    env.out(`${slug} v${view.version} is already installed`);
  } else {
    const downloaded = await inParallel(manifest, DOWNLOADS, async ([path, hash]) => {
      const bytes = await client.getFile(slug, path, view.version);
      if (sha256(bytes) !== hash) throw new Error(`checksum mismatch for "${safe(path)}"`);
      return [path, bytes] as const;
    });
    // Every file matched its manifest hash, so the manifest is the marker's list as is.
    await writeSkillDir(plan.canonical, new Map(downloaded), {
      server,
      slug,
      version: view.version,
      files: Object.fromEntries(manifest),
    });
    env.out(`installed ${slug} v${view.version} → ${plan.canonical}`);
  }

  await inSequence(links, async (l) => {
    if (l.state === 'link' && !o.copy) return;
    if (l.state === 'copy' && o.copy && current) return;
    if (l.state !== 'absent') await rm(l.path, { recursive: true, force: true });
    const made = await linkOrCopy(plan.canonical, l.path, { copy: o.copy, platform: env.platform });
    if (made === 'copy' && !o.copy) {
      env.err(`warning: cannot create a symlink at ${l.path}; copied instead`);
    }
    env.out(`  ${made === 'link' ? 'linked' : 'copied'} ${l.agent}: ${l.path}`);
  });
  return true;
}

/** `install <slug>[@<version>]... [-g] [-a <agent>]... [--copy] [--dir <path>] [--force]`. */
export const installCommand: Command = async (args, env) => {
  const { values, positionals } = parse(args, options, { min: 1, max: Infinity });
  const targets = positionals.map(parseTarget);
  const agents = selectAgents(values.agent ?? [], env);
  const conn = await requireConnection(env);
  const client = new RegistryClient(conn, env.fetch);
  const server = conn.url.replace(/\/+$/, '');
  const o: Opts = {
    global: values.global ?? false,
    copy: values.copy ?? false,
    force: values.force ?? false,
    dir: values.dir,
  };
  const results = await inSequence(targets, async (t) => {
    try {
      return await installOne(env, client, server, agents, t, o);
    } catch (e) {
      env.err(`error: ${t.slug}: ${safe(e instanceof Error ? e.message : String(e))}`);
      return false;
    }
  });
  return results.every(Boolean) ? 0 : 1;
};
