import { err, ok, type Result } from '../../../../shared-kernel/index.ts';
import { CatalogError } from '../../domain/errors.ts';
import { Skill } from '../../domain/skill.ts';
import { Slug } from '../../domain/slug.ts';
import { parseSourceCommit, parseSourceRef, type SourceRef } from '../../domain/source.ts';
import type { CatalogDeps } from '../deps.ts';
import { buildVersionInput, type FileInput } from '../file-input.ts';
import { saveSkill } from '../save.ts';
import { loadActiveFolder } from './folders.ts';

/** `folder` is the slug of an active folder. */
export async function createSkill(
  deps: CatalogDeps,
  cmd: {
    slug: string;
    folder: string;
    files: FileInput[];
    actorId: string;
    message: string | null;
    /** Where an imported skill came from; null for a skill made in the registry. */
    source: { host: string; repo: string; path: string; ref: string | null } | null;
    /** The upstream commit of version 1; given exactly when `source` is. */
    sourceCommit: string | null;
  },
): Promise<Result<{ slug: string; version: number }, CatalogError>> {
  const slug = Slug.parse(cmd.slug);
  if (!slug.ok) return slug;
  let source: SourceRef | null = null;
  if (cmd.source) {
    const parsed = parseSourceRef(cmd.source);
    if (!parsed.ok) return parsed;
    source = parsed.value;
  }
  let sourceCommit: string | null = null;
  if (cmd.sourceCommit !== null) {
    const parsed = parseSourceCommit(cmd.sourceCommit);
    if (!parsed.ok) return parsed;
    sourceCommit = parsed.value;
  }
  if (Slug.isReserved(slug.value)) return err(Slug.reservedError(slug.value));
  if (await deps.skills.findBySlug(slug.value)) {
    return err(new CatalogError('skill_exists', `skill "${cmd.slug}" already exists`));
  }
  const folder = await loadActiveFolder(deps.folders, cmd.folder);
  if (!folder.ok) return folder;
  const input = buildVersionInput(cmd.files, deps.hasher);
  if (!input.ok) return input;
  const skill = Skill.create({
    id: deps.ids.uuid(),
    slug: slug.value,
    folderId: folder.value.id,
    skillMd: input.value.skillMd,
    manifest: input.value.manifest,
    authorId: cmd.actorId,
    message: cmd.message,
    now: deps.clock.now(),
    source,
    sourceCommit,
  });
  if (!skill.ok) return skill;
  const saved = await saveSkill(deps.skills, skill.value, input.value.blobs);
  if (!saved.ok) return saved;
  await deps.audit.record({
    actorId: cmd.actorId,
    action: 'skill.create',
    target: cmd.slug,
    meta: source
      ? {
          version: 1,
          folder: cmd.folder,
          source: `${source.repo}/${source.path}`,
          commit: sourceCommit,
        }
      : { version: 1, folder: cmd.folder },
  });
  return ok({ slug: cmd.slug, version: 1 });
}
