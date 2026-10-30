import { err, ok, type Result } from '../../../../shared-kernel/index.ts';
import { CatalogError } from '../../domain/errors.ts';
import { FilePath } from '../../domain/file-path.ts';
import type { ManifestEntry } from '../../domain/manifest.ts';
import type { SkillVersion } from '../../domain/skill.ts';
import { Slug } from '../../domain/slug.ts';
import { parseSourceCommit } from '../../domain/source.ts';
import type { CatalogDeps } from '../deps.ts';
import { buildVersionInput, type FileInput, type KeptFiles } from '../file-input.ts';
import { saveSkill } from '../save.ts';

/**
 * Resolves `keep` paths against the base version's manifest. Entries are reused as they are
 * (hash, size, binary), so their content is not uploaded again; only a kept SKILL.md is read,
 * because the new version's name and description come from its frontmatter.
 */
async function resolveKept(
  deps: Pick<CatalogDeps, 'blobs'>,
  base: SkillVersion,
  keep: string[],
): Promise<Result<KeptFiles, CatalogError>> {
  const entries: ManifestEntry[] = [];
  for (const raw of keep) {
    const path = FilePath.parse(raw);
    if (!path.ok) return path;
    const entry = base.manifest.get(path.value);
    if (!entry) {
      return err(
        new CatalogError(
          'file_not_found',
          `file "${path.value.value}" not found in version ${base.number}`,
        ),
      );
    }
    entries.push(entry);
  }
  const md = entries.find((e) => e.path.value === FilePath.SKILL_MD);
  if (!md) return ok({ entries, skillMdText: null });
  const bytes = await deps.blobs.get(md.hash);
  if (!bytes) return err(new CatalogError('file_not_found', 'SKILL.md content is missing'));
  return ok({ entries, skillMdText: new TextDecoder().decode(bytes) });
}

export async function publishVersion(
  deps: CatalogDeps,
  cmd: {
    slug: string;
    baseVersion: number;
    files: FileInput[];
    /** Paths of the base version kept unchanged; their content is not sent again. */
    keepFromBase: string[];
    actorId: string;
    message: string | null;
    /** The upstream commit this version was taken from; only for an imported skill. */
    sourceCommit: string | null;
  },
): Promise<Result<{ slug: string; version: number }, CatalogError>> {
  const slug = Slug.parse(cmd.slug);
  if (!slug.ok) return slug;
  if (cmd.sourceCommit !== null) {
    const commit = parseSourceCommit(cmd.sourceCommit);
    if (!commit.ok) return commit;
  }
  const skill = await deps.skills.findBySlug(slug.value);
  if (!skill) return err(new CatalogError('skill_not_found', `skill "${cmd.slug}" not found`));
  // The base must be the current version, so kept paths are resolved against skill.latest.
  const writable = skill.assertWritable(cmd.baseVersion);
  if (!writable.ok) return writable;
  const kept = await resolveKept(deps, skill.latest, cmd.keepFromBase);
  if (!kept.ok) return kept;
  const input = buildVersionInput(cmd.files, deps.hasher, kept.value);
  if (!input.ok) return input;
  const published = skill.publish({
    skillMd: input.value.skillMd,
    manifest: input.value.manifest,
    authorId: cmd.actorId,
    message: cmd.message,
    now: deps.clock.now(),
    baseVersion: cmd.baseVersion,
    sourceCommit: cmd.sourceCommit,
  });
  if (!published.ok) return published;
  const saved = await saveSkill(deps.skills, skill, input.value.blobs);
  if (!saved.ok) return saved;
  const version = published.value.number;
  await deps.audit.record({
    actorId: cmd.actorId,
    action: 'skill.publish',
    target: cmd.slug,
    meta: cmd.sourceCommit === null ? { version } : { version, sourceCommit: cmd.sourceCommit },
  });
  return ok({ slug: cmd.slug, version });
}
