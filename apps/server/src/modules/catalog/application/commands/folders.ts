import { err, ok, type Result } from '../../../../shared-kernel/index.ts';
import { CatalogError } from '../../domain/errors.ts';
import { Folder } from '../../domain/folder.ts';
import { Slug } from '../../domain/slug.ts';
import type { CatalogDeps } from '../deps.ts';
import type { FolderRef, FolderRepository } from '../ports.ts';

/** How many times archiveFolder re-reads and retries after a concurrent change. */
const ARCHIVE_ATTEMPTS = 3;

/** Parses the slug and loads the folder: invalid_slug, folder_not_found. */
export async function loadFolder(
  folders: FolderRepository,
  raw: string,
): Promise<Result<Folder, CatalogError>> {
  const slug = Slug.parse(raw);
  if (!slug.ok) return slug;
  const folder = await folders.findBySlug(slug.value);
  if (!folder) return err(new CatalogError('folder_not_found', `folder "${raw}" not found`));
  return ok(folder);
}

/** A folder a skill may be put in: as loadFolder, plus folder_archived. */
export async function loadActiveFolder(
  folders: FolderRepository,
  raw: string,
): Promise<Result<Folder, CatalogError>> {
  const folder = await loadFolder(folders, raw);
  if (folder.ok) {
    const archived = archivedError(folder.value);
    if (archived) return err(archived);
  }
  return folder;
}

export function archivedError(folder: Folder): CatalogError | null {
  return folder.status === 'archived'
    ? new CatalogError('folder_archived', `folder "${folder.slug.value}" is archived`)
    : null;
}

/** Runs a repository write; CatalogErrors (folder_exists, version_conflict…) become Results. */
async function write(run: () => Promise<void>): Promise<Result<void, CatalogError>> {
  try {
    await run();
    return ok(undefined);
  } catch (cause) {
    if (cause instanceof CatalogError) return err(cause);
    throw cause;
  }
}

const ref = (f: Folder): FolderRef => ({ slug: f.slug.value, name: f.name });

export async function createFolder(
  deps: CatalogDeps,
  cmd: { slug: string; name: string; description: string; actorId: string },
): Promise<Result<FolderRef, CatalogError>> {
  const slug = Slug.parse(cmd.slug);
  if (!slug.ok) return slug;
  const folder = Folder.create({
    id: deps.ids.uuid(),
    slug: slug.value,
    name: cmd.name,
    description: cmd.description,
    now: deps.clock.now(),
  });
  if (!folder.ok) return folder;
  const saved = await write(() => deps.folders.save(folder.value));
  if (!saved.ok) return saved;
  await deps.audit.record({ actorId: cmd.actorId, action: 'folder.create', target: cmd.slug });
  return ok(ref(folder.value));
}

export async function updateFolder(
  deps: CatalogDeps,
  cmd: { slug: string; name: string; description: string; actorId: string },
): Promise<Result<FolderRef, CatalogError>> {
  const folder = await loadFolder(deps.folders, cmd.slug);
  if (!folder.ok) return folder;
  const edited = folder.value.edit({
    name: cmd.name,
    description: cmd.description,
    now: deps.clock.now(),
  });
  if (!edited.ok) return edited;
  if (edited.value) {
    const saved = await write(() => deps.folders.save(folder.value));
    if (!saved.ok) return saved;
    await deps.audit.record({ actorId: cmd.actorId, action: 'folder.update', target: cmd.slug });
  }
  return ok(ref(folder.value));
}

/**
 * Archives the folder and all its active skills in one transaction. A skill created in, moved into
 * or published in the folder meanwhile makes the write a version_conflict: re-read and retry.
 */
export function archiveFolder(
  deps: CatalogDeps,
  cmd: { slug: string; actorId: string },
): Promise<Result<{ archivedSkills: number }, CatalogError>> {
  return archiveAttempt(deps, cmd, ARCHIVE_ATTEMPTS);
}

async function archiveAttempt(
  deps: CatalogDeps,
  cmd: { slug: string; actorId: string },
  attemptsLeft: number,
): Promise<Result<{ archivedSkills: number }, CatalogError>> {
  const folder = await loadFolder(deps.folders, cmd.slug);
  if (!folder.ok) return folder;
  if (folder.value.status === 'archived') return ok({ archivedSkills: 0 });
  const skills = await deps.skills.listActiveInFolder(folder.value.id);
  const now = deps.clock.now();
  folder.value.archive(now);
  for (const skill of skills) skill.archive(cmd.actorId, now);
  const saved = await write(() => deps.folders.archiveWithSkills(folder.value, skills));
  if (!saved.ok) {
    if (saved.error.code === 'version_conflict' && attemptsLeft > 1) {
      return archiveAttempt(deps, cmd, attemptsLeft - 1);
    }
    return saved;
  }
  await deps.audit.record({
    actorId: cmd.actorId,
    action: 'folder.archive',
    target: cmd.slug,
    meta: { archivedSkills: skills.length },
  });
  await skills.reduce(async (prev, skill) => {
    await prev;
    await deps.audit.record({
      actorId: cmd.actorId,
      action: 'skill.archive',
      target: skill.slug.value,
      meta: { version: skill.currentVersion, viaFolder: cmd.slug },
    });
  }, Promise.resolve());
  return ok({ archivedSkills: skills.length });
}

/** Restores only the folder; its skills stay archived and are restored one by one. */
export async function restoreFolder(
  deps: CatalogDeps,
  cmd: { slug: string; actorId: string },
): Promise<Result<void, CatalogError>> {
  const folder = await loadFolder(deps.folders, cmd.slug);
  if (!folder.ok) return folder;
  if (!folder.value.restore(deps.clock.now())) return ok(undefined);
  const saved = await write(() => deps.folders.save(folder.value, 'archived'));
  if (!saved.ok) return saved;
  await deps.audit.record({ actorId: cmd.actorId, action: 'folder.restore', target: cmd.slug });
  return ok(undefined);
}
