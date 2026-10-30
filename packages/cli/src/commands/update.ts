import type { SkillSource, SkillView } from '@skills/contracts';
import { parse } from '../args.ts';
import { requireConnection } from '../config.ts';
import type { CliEnv, Command } from '../env.ts';
import { fetchSkill } from '../github/fetch-skill.ts';
import { parseSource } from '../github/source.ts';
import { tarLimits } from '../limits.ts';
import {
  diffManifests,
  hashFiles,
  type LocalManifest,
  manifestOf,
  sameManifest,
} from '../manifest.ts';
import { safe } from '../output.ts';
import { RegistryClient, RegistryError } from '../registry.ts';
import { sourceLabel, sourceName } from '../source-message.ts';
import { githubOf, reportSkipped } from './import.ts';

const options = { 'dry-run': { type: 'boolean' } } as const;

/** The explicit `<source>` must name the skill's source: repo, path when given, ref when given. */
function checkSource(source: SkillSource, raw: string): void {
  const t = parseSource(raw);
  const same =
    t.repo === source.repo &&
    (t.path === null || t.path === source.path) &&
    (t.ref === null || t.ref === source.ref);
  if (!same) throw new Error(`source mismatch: skill comes from ${sourceName(source)}, not ${raw}`);
}

/** Warns (stderr) when the current version's content differs from the synced one. */
async function warnLocalChanges(
  env: CliEnv,
  client: RegistryClient,
  view: SkillView,
  syncedView: SkillView | null,
  current: LocalManifest,
  label: string,
): Promise<void> {
  const synced = view.source?.syncedVersion ?? view.version;
  const base: LocalManifest = syncedView === null ? new Map() : manifestOf(syncedView);
  if (sameManifest(base, current)) return;
  const later = (await client.history(view.slug))
    .filter((v) => v.number > synced && v.number <= view.version)
    .toSorted((a, b) => a.number - b.number)
    .map((v) => `v${v.number} (${safe(v.authorLogin ?? 'unknown')})`);
  const d = diffManifests(base, current);
  const changed = [...d.added, ...d.modified, ...d.removed].toSorted().map(safe);
  const slug = safe(view.slug);
  env.err(
    `warning: ${slug} has changes made in the registry since v${synced}: ${later.join(', ')}`,
  );
  env.err(`  they will be overwritten by ${safe(label)}`);
  env.err(`  changed files: ${changed.join(', ')}`);
  env.err(`  to restore: roll back to v${view.version} in the UI`);
}

/** `update <slug> [<source>] [--dry-run]`: a new version from the skill's upstream commit. */
export const updateCommand: Command = async (args, env) => {
  const { values, positionals } = parse(args, options, { min: 1, max: 2 });
  const slug = positionals[0] ?? '';
  const client = new RegistryClient(await requireConnection(env), env.fetch);
  const view = await client.getSkill(slug);
  if (view === null) throw new Error(`skill "${slug}" not found`);
  const { source } = view;
  if (source === null) throw new Error(`skill "${slug}" was not imported; nothing to update from`);
  if (view.status === 'archived') throw new Error(`skill "${slug}" is archived`);
  const raw = positionals[1];
  if (raw !== undefined) checkSource(source, raw);

  const gh = githubOf(env);
  const commit = await gh.resolveCommit(source.repo, source.ref);
  const synced = source.syncedVersion;
  const syncedView = synced === view.version ? view : await client.getSkill(slug, synced);
  if (syncedView !== null && syncedView.sourceCommit === commit) {
    env.out(`${safe(slug)} is up to date (${safe(sourceLabel(source, commit))})`);
    if (view.version !== synced) {
      env.out(`  registry changes since v${synced} are kept (v${view.version})`);
    }
    return 0;
  }

  // The resolved commit, so the comparison above and the download read the same tree.
  const target = { repo: source.repo, ref: commit, path: source.path };
  const upstream = await fetchSkill(gh, target, null, tarLimits(env.vars));
  reportSkipped(env, upstream);
  if (upstream.name !== slug) {
    throw new Error(`upstream renamed the skill to "${upstream.name}"; update is not supported`);
  }
  const label = sourceLabel(source, upstream.commit);
  const current = manifestOf(view);
  const next = hashFiles(upstream.files);
  if (sameManifest(current, next)) {
    env.out(`${safe(slug)} is up to date (v${view.version}, ${safe(label)})`);
    return 0;
  }
  await warnLocalChanges(env, client, view, syncedView, current, label);

  const d = diffManifests(current, next);
  const changes = [
    ...d.added.map((p) => `  + ${safe(p)}`),
    ...d.modified.map((p) => `  ~ ${safe(p)}`),
    ...d.removed.map((p) => `  - ${safe(p)}`),
  ];
  if (values['dry-run']) {
    env.out(
      `would update ${safe(slug)} v${view.version} → v${view.version + 1} from ${safe(label)}`,
    );
    for (const line of changes) env.out(line);
    return 0;
  }
  let published;
  try {
    published = await client.publishVersion(slug, {
      baseVersion: view.version,
      files: upstream.files,
      message: `update from ${label}`,
      sourceCommit: upstream.commit,
    });
  } catch (e) {
    if (e instanceof RegistryError && e.code === 'version_conflict') {
      throw new Error(`skill "${slug}" changed while updating; run update again`, { cause: e });
    }
    throw e;
  }
  env.out(`updated ${safe(slug)} v${view.version} → v${published.version} from ${safe(label)}`);
  for (const line of changes) env.out(line);
  return 0;
};
