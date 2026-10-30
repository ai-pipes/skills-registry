import { err, ok, type Result } from '../../../../shared-kernel/index.ts';
import { CatalogError } from '../../domain/errors.ts';
import type { Folder } from '../../domain/folder.ts';
import type { Skill } from '../../domain/skill.ts';
import type { CatalogDeps } from '../deps.ts';
import { loadSkill } from '../queries/load.ts';
import { saveSkill } from '../save.ts';
import { archivedError, loadFolder } from './folders.ts';

/** The slug of the folder a skill is in now (for audit `from`). */
async function currentFolderSlug(deps: Pick<CatalogDeps, 'folders'>, skill: Skill) {
  const folder = await deps.folders.findById(skill.folderId);
  if (!folder) throw new Error(`folder ${skill.folderId} of skill ${skill.id} is missing`);
  return folder.slug.value;
}

/** Moves the skill to `target` in memory; audit meta when it moved, null when it was there already. */
export async function moveInMemory(
  deps: CatalogDeps,
  skill: Skill,
  target: Folder,
): Promise<Result<{ from: string; to: string } | null, CatalogError>> {
  const from = await currentFolderSlug(deps, skill);
  const moved = skill.moveTo({
    folderId: target.id,
    folderSlug: target.slug.value,
    now: deps.clock.now(),
  });
  if (!moved.ok) return moved;
  return ok(moved.value ? { from, to: target.slug.value } : null);
}

/** Moves an active skill to another active folder; no new version. */
export async function moveSkill(
  deps: CatalogDeps,
  cmd: { slug: string; folder: string; actorId: string },
): Promise<Result<void, CatalogError>> {
  const skill = await loadSkill(deps.skills, cmd.slug);
  if (!skill.ok) return skill;
  const target = await loadFolder(deps.folders, cmd.folder);
  if (!target.ok) return target;
  if (skill.value.status === 'archived') {
    return err(new CatalogError('skill_archived', `skill "${cmd.slug}" is archived`));
  }
  const archived = archivedError(target.value);
  if (archived) return err(archived);
  const moved = await moveInMemory(deps, skill.value, target.value);
  if (!moved.ok) return moved;
  if (!moved.value) return ok(undefined);
  const saved = await saveSkill(deps.skills, skill.value, new Map());
  if (!saved.ok) return saved;
  await deps.audit.record({
    actorId: cmd.actorId,
    action: 'skill.move',
    target: cmd.slug,
    meta: moved.value,
  });
  return ok(undefined);
}
