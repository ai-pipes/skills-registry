import { err, ok, type Result } from '../../../../shared-kernel/index.ts';
import type { CatalogError } from '../../domain/errors.ts';
import type { Folder } from '../../domain/folder.ts';
import type { CatalogDeps } from '../deps.ts';
import { loadSkill } from '../queries/load.ts';
import { saveSkill } from '../save.ts';
import { archivedError, loadActiveFolder } from './folders.ts';
import { moveInMemory } from './move-skill.ts';

type Cmd = { slug: string; actorId: string };

export async function archiveSkill(
  deps: CatalogDeps,
  cmd: Cmd,
): Promise<Result<void, CatalogError>> {
  const skill = await loadSkill(deps.skills, cmd.slug);
  if (!skill.ok) return skill;
  skill.value.archive(cmd.actorId, deps.clock.now());
  const saved = await saveSkill(deps.skills, skill.value, new Map());
  if (!saved.ok) return saved;
  await deps.audit.record({
    actorId: cmd.actorId,
    action: 'skill.archive',
    target: cmd.slug,
    meta: { version: skill.value.currentVersion },
  });
  return ok(undefined);
}

/**
 * Restores a skill in its folder, or with `folder` restores it into that folder (restore and move
 * in one save). A skill never becomes active inside an archived folder: folder_archived.
 */
export async function restoreSkill(
  deps: CatalogDeps,
  cmd: Cmd & { folder?: string },
): Promise<Result<void, CatalogError>> {
  const skill = await loadSkill(deps.skills, cmd.slug);
  if (!skill.ok) return skill;
  let target: Folder | null = null;
  if (cmd.folder === undefined) {
    const current = await deps.folders.findById(skill.value.folderId);
    const archived = current && archivedError(current);
    if (archived) return err(archived);
  } else {
    const found = await loadActiveFolder(deps.folders, cmd.folder);
    if (!found.ok) return found;
    target = found.value;
  }
  skill.value.restore(cmd.actorId, deps.clock.now());
  const moved = target ? await moveInMemory(deps, skill.value, target) : ok(null);
  if (!moved.ok) return moved;
  const saved = await saveSkill(deps.skills, skill.value, new Map());
  if (!saved.ok) return saved;
  await deps.audit.record({
    actorId: cmd.actorId,
    action: 'skill.restore',
    target: cmd.slug,
    meta: { version: skill.value.currentVersion },
  });
  if (moved.value) {
    await deps.audit.record({
      actorId: cmd.actorId,
      action: 'skill.move',
      target: cmd.slug,
      meta: moved.value,
    });
  }
  return ok(undefined);
}
