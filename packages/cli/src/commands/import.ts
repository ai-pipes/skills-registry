import type { FolderSummary } from '@skills/contracts';
import { parse, UsageError } from '../args.ts';
import { requireConnection } from '../config.ts';
import type { CliEnv, Command } from '../env.ts';
import { GithubClient } from '../github/client.ts';
import { type FetchedSkill, fetchSkill, fetchSkills } from '../github/fetch-skill.ts';
import { inSequence } from '../install/layout.ts';
import { type GithubTarget, parseSource } from '../github/source.ts';
import { type TarLimits, tarLimits } from '../limits.ts';
import { safe } from '../output.ts';
import { RegistryClient } from '../registry.ts';
import { sourceLabel } from '../source-message.ts';

const options = {
  skill: { type: 'string', multiple: true },
  folder: { type: 'string' },
  ref: { type: 'string' },
  'dry-run': { type: 'boolean' },
} as const;

// Folder limits of the registry.
const MAX_FOLDER_NAME = 100;
const MAX_FOLDER_DESCRIPTION = 1000;

/** The GitHub API client of `GITHUB_API_URL` / `GITHUB_TOKEN`. */
export function githubOf(env: CliEnv): GithubClient {
  const token = env.vars.GITHUB_TOKEN;
  return new GithubClient(env.fetch, {
    apiUrl: env.vars.GITHUB_API_URL || 'https://api.github.com',
    ...(token ? { token } : {}),
  });
}

/** The skill's skipped files (non-regular, or with a path the registry would change), on stderr. */
export function reportSkipped(env: CliEnv, skill: FetchedSkill): void {
  for (const p of skill.skipped)
    env.err(`skipped (not a regular file or path the registry would change): ${safe(p)}`);
}

/** At most `n` UTF-16 units, without splitting a surrogate pair. */
function truncate(s: string, n: number): string {
  if (s.length <= n) return s;
  const cut = s.slice(0, n);
  const last = cut.charCodeAt(n - 1);
  return last >= 0xd800 && last <= 0xdbff ? cut.slice(0, -1) : cut;
}

type Outcome = 'created' | 'conflict';

type Ctx = {
  env: CliEnv;
  client: RegistryClient;
  gh: GithubClient;
  target: GithubTarget;
  folder: string | undefined;
  dryRun: boolean;
  tarLimits: TarLimits;
};

async function importOne(ctx: Ctx, skill: FetchedSkill): Promise<Outcome> {
  const { env, client } = ctx;
  reportSkipped(env, skill);
  const slug = skill.name;
  if ((await client.getSkill(slug)) !== null) {
    env.err(`conflict: skill "${safe(slug)}" already exists`);
    return 'conflict';
  }
  const folders: FolderSummary[] = await client.listFolders('all');
  const folder = ctx.folder ?? slug;
  const existing = folders.find((f) => f.slug === folder);
  if (ctx.folder === undefined && existing !== undefined) {
    env.err(`conflict: folder "${safe(folder)}" already exists; pass --folder <slug>`);
    return 'conflict';
  }
  if (existing?.status === 'archived') {
    env.err(`folder "${safe(folder)}" is archived`);
    return 'conflict';
  }
  // A missing folder is created: named after the skill, or as given by --folder.
  const isNew = existing === undefined;
  const label = sourceLabel(skill, skill.commit);
  const where = `in folder ${safe(folder)} (${isNew ? 'new' : 'existing'})`;
  if (ctx.dryRun) {
    env.out(`would create ${safe(slug)} ${where} from ${safe(label)}`);
    for (const [p, bytes] of [...skill.files].toSorted(([a], [b]) => (a < b ? -1 : 1))) {
      env.out(`  ${safe(p)}\t${bytes.length}`);
    }
    return 'created';
  }
  if (isNew) {
    await client.createFolder(
      ctx.folder === undefined
        ? {
            slug,
            name: truncate(skill.name, MAX_FOLDER_NAME),
            description: truncate(skill.description, MAX_FOLDER_DESCRIPTION),
          }
        : // The registry needs a non-empty description; the slug fits both limits.
          { slug: folder, name: folder, description: `skills imported from ${skill.repo}` },
    );
  }
  let created;
  try {
    created = await client.createSkill({
      slug,
      folder,
      files: skill.files,
      message: `import from ${label}`,
      source: {
        host: 'github.com',
        repo: skill.repo,
        path: skill.path,
        ref: skill.ref,
        commit: skill.commit,
      },
    });
  } catch (e) {
    if (isNew) {
      env.err(
        `folder "${safe(folder)}" was created but the skill was not; archive it in the UI if not needed`,
      );
    }
    throw e;
  }
  env.out(
    `created ${safe(slug)} v${created.version} ${where} from ${safe(label)} (${skill.files.size} files)`,
  );
  return 'created';
}

/** `import <source> [--skill <name>]... [--folder <slug>] [--ref <ref>] [--dry-run]`. */
export const importCommand: Command = async (args, env) => {
  const { values, positionals } = parse(args, options, { min: 1, max: 1 });
  const target = parseSource(positionals[0] ?? '', values.ref);
  const names = values.skill ?? [];
  if (target.path === null && names.length === 0) {
    throw new UsageError('pass --skill <name> or a URL with the path to the skill');
  }
  if (target.path !== null && names.length > 1) {
    throw new UsageError('a URL with a path names one skill; pass at most one --skill');
  }
  const ctx: Ctx = {
    env,
    client: new RegistryClient(await requireConnection(env), env.fetch),
    gh: githubOf(env),
    target,
    folder: values.folder,
    dryRun: values['dry-run'] ?? false,
    tarLimits: tarLimits(env.vars),
  };
  if (names.length <= 1) {
    const skill = await fetchSkill(ctx.gh, target, names[0] ?? null, ctx.tarLimits);
    return (await importOne(ctx, skill)) === 'created' ? 0 : 1;
  }
  // All skills from one commit and one tarball pass (plus one for dirs named differently).
  const skills = await fetchSkills(ctx.gh, target, names, ctx.tarLimits);
  const count = { created: 0, conflict: 0, failed: 0 };
  // One after another, so the output stays in order.
  await inSequence(skills, async (skill) => {
    try {
      if (skill instanceof Error) throw skill;
      count[await importOne(ctx, skill)]++;
    } catch (e) {
      if (e instanceof UsageError) throw e;
      env.err(`error: ${safe(e instanceof Error ? e.message : String(e))}`);
      count.failed++;
    }
  });
  const verb = ctx.dryRun ? 'would create' : 'created';
  env.out(`${verb} ${count.created}, conflicts ${count.conflict}, failed ${count.failed}`);
  return count.conflict + count.failed > 0 ? 1 : 0;
};
