import { err, ok, type Result } from '../../../../shared-kernel/index.ts';
import type { ContentHash } from '../../domain/content-hash.ts';
import { CatalogError } from '../../domain/errors.ts';
import type { Folder } from '../../domain/folder.ts';
import { Slug } from '../../domain/slug.ts';
import { type ParsedSubagentMd, parseSubagentMd } from '../../domain/subagent-md.ts';
import { Subagent } from '../../domain/subagent.ts';
import type { CatalogDeps } from '../deps.ts';
import { loadSubagent } from '../queries/load.ts';
import { saveSubagent } from '../save.ts';
import { archivedError, loadActiveFolder, loadFolder } from './folders.ts';

type Written = { slug: string; version: number };

type Prepared = {
  md: ParsedSubagentMd;
  contentHash: ContentHash;
  size: number;
  blobs: Map<string, Uint8Array>;
};

/** Parses SUBAGENT.md, checks that every listed skill is an active one, hashes the content. */
async function prepare(
  deps: CatalogDeps,
  content: string,
): Promise<Result<Prepared, CatalogError>> {
  const md = parseSubagentMd(content);
  if (!md.ok) return md;
  // Slugs were validated by the parser; the first inactive one in list order is reported.
  const active = await Promise.all(
    md.value.skills.map(async (raw) => {
      const slug = Slug.parse(raw);
      const skill = slug.ok ? await deps.skills.findBySlug(slug.value) : null;
      return skill?.status === 'active';
    }),
  );
  const missing = md.value.skills.find((_, i) => !active[i]);
  if (missing !== undefined) {
    return err(new CatalogError('unknown_skill', `skill "${missing}" is not an active skill`));
  }
  const bytes = new TextEncoder().encode(content);
  const contentHash = deps.hasher.sha256(bytes);
  return ok({
    md: md.value,
    contentHash,
    size: bytes.length,
    blobs: new Map([[contentHash.value, bytes]]),
  });
}

/** `folder` is the slug of an active folder. */
export async function createSubagent(
  deps: CatalogDeps,
  cmd: {
    slug: string;
    folder: string;
    content: string;
    actorId: string;
    message: string | null;
  },
): Promise<Result<Written, CatalogError>> {
  const slug = Slug.parse(cmd.slug);
  if (!slug.ok) return slug;
  if (Slug.isReserved(slug.value)) return err(Slug.reservedError(slug.value, 'subagent'));
  if (await deps.subagents.findBySlug(slug.value)) {
    return err(new CatalogError('subagent_exists', `subagent "${cmd.slug}" already exists`));
  }
  const folder = await loadActiveFolder(deps.folders, cmd.folder);
  if (!folder.ok) return folder;
  const prepared = await prepare(deps, cmd.content);
  if (!prepared.ok) return prepared;
  const subagent = Subagent.create({
    id: deps.ids.uuid(),
    slug: slug.value,
    folderId: folder.value.id,
    md: prepared.value.md,
    contentHash: prepared.value.contentHash,
    size: prepared.value.size,
    authorId: cmd.actorId,
    message: cmd.message,
    now: deps.clock.now(),
  });
  if (!subagent.ok) return subagent;
  const saved = await saveSubagent(deps.subagents, subagent.value, prepared.value.blobs);
  if (!saved.ok) return saved;
  await deps.audit.record({
    actorId: cmd.actorId,
    action: 'subagent.create',
    target: cmd.slug,
    meta: { version: 1, folder: cmd.folder },
  });
  return ok({ slug: cmd.slug, version: 1 });
}

export async function publishSubagent(
  deps: CatalogDeps,
  cmd: {
    slug: string;
    baseVersion: number;
    content: string;
    actorId: string;
    message: string | null;
  },
): Promise<Result<Written, CatalogError>> {
  const subagent = await loadSubagent(deps.subagents, cmd.slug);
  if (!subagent.ok) return subagent;
  // Fail on a stale base or an archived subagent before looking at the content.
  const writable = subagent.value.assertWritable(cmd.baseVersion);
  if (!writable.ok) return writable;
  const prepared = await prepare(deps, cmd.content);
  if (!prepared.ok) return prepared;
  const published = subagent.value.publish({
    md: prepared.value.md,
    contentHash: prepared.value.contentHash,
    size: prepared.value.size,
    authorId: cmd.actorId,
    message: cmd.message,
    now: deps.clock.now(),
    baseVersion: cmd.baseVersion,
  });
  if (!published.ok) return published;
  const saved = await saveSubagent(deps.subagents, subagent.value, prepared.value.blobs);
  if (!saved.ok) return saved;
  const version = published.value.number;
  await deps.audit.record({
    actorId: cmd.actorId,
    action: 'subagent.publish',
    target: cmd.slug,
    meta: { version },
  });
  return ok({ slug: cmd.slug, version });
}

/** Skills the target version lists are not re-checked: they may have been archived since. */
export async function rollbackSubagent(
  deps: CatalogDeps,
  cmd: { slug: string; toVersion: number; baseVersion: number; actorId: string },
): Promise<Result<Written, CatalogError>> {
  const subagent = await loadSubagent(deps.subagents, cmd.slug);
  if (!subagent.ok) return subagent;
  const notFound = () =>
    err(new CatalogError('version_not_found', `version ${cmd.toVersion} cannot be rolled back to`));
  if (
    !Number.isInteger(cmd.toVersion) ||
    cmd.toVersion < 1 ||
    cmd.toVersion >= subagent.value.currentVersion
  ) {
    return notFound();
  }
  const target = await deps.subagents.getVersion(subagent.value.id, cmd.toVersion);
  if (!target) return notFound();
  const rolled = subagent.value.rollback({
    toVersion: target,
    baseVersion: cmd.baseVersion,
    authorId: cmd.actorId,
    now: deps.clock.now(),
  });
  if (!rolled.ok) return rolled;
  // The blob of the target version is already stored.
  const saved = await saveSubagent(deps.subagents, subagent.value, new Map());
  if (!saved.ok) return saved;
  const version = rolled.value.number;
  await deps.audit.record({
    actorId: cmd.actorId,
    action: 'subagent.rollback',
    target: cmd.slug,
    meta: { version },
  });
  return ok({ slug: cmd.slug, version });
}

export async function archiveSubagent(
  deps: CatalogDeps,
  cmd: { slug: string; actorId: string },
): Promise<Result<void, CatalogError>> {
  const subagent = await loadSubagent(deps.subagents, cmd.slug);
  if (!subagent.ok) return subagent;
  const archived = subagent.value.archive(deps.clock.now());
  if (!archived.ok) return archived;
  const saved = await saveSubagent(deps.subagents, subagent.value, new Map());
  if (!saved.ok) return saved;
  await deps.audit.record({
    actorId: cmd.actorId,
    action: 'subagent.archive',
    target: cmd.slug,
    meta: { version: subagent.value.currentVersion },
  });
  return ok(undefined);
}

/** The slug of the folder a subagent is in now (for audit `from`). */
async function currentFolderSlug(deps: Pick<CatalogDeps, 'folders'>, subagent: Subagent) {
  const folder = await deps.folders.findById(subagent.folderId);
  if (!folder) throw new Error(`folder ${subagent.folderId} of subagent ${subagent.id} is missing`);
  return folder.slug.value;
}

/** Moves in memory; audit meta when it moved, null when it was there already. */
async function moveInMemory(
  deps: CatalogDeps,
  subagent: Subagent,
  target: Folder,
): Promise<Result<{ from: string; to: string } | null, CatalogError>> {
  const from = await currentFolderSlug(deps, subagent);
  const moved = subagent.moveTo({
    folderId: target.id,
    folderSlug: target.slug.value,
    now: deps.clock.now(),
  });
  if (!moved.ok) return moved;
  return ok(moved.value ? { from, to: target.slug.value } : null);
}

/**
 * Restores a subagent in its folder, or with `folder` into that folder (restore and move in one
 * save). A subagent never becomes active inside an archived folder: folder_archived. The skills
 * it lists are not re-checked.
 */
export async function restoreSubagent(
  deps: CatalogDeps,
  cmd: { slug: string; actorId: string; folder?: string },
): Promise<Result<void, CatalogError>> {
  const subagent = await loadSubagent(deps.subagents, cmd.slug);
  if (!subagent.ok) return subagent;
  let target: Folder | null = null;
  if (cmd.folder === undefined) {
    const current = await deps.folders.findById(subagent.value.folderId);
    const archived = current && archivedError(current);
    if (archived) return err(archived);
  } else {
    const found = await loadActiveFolder(deps.folders, cmd.folder);
    if (!found.ok) return found;
    target = found.value;
  }
  const restored = subagent.value.restore(deps.clock.now());
  if (!restored.ok) return restored;
  const moved = target ? await moveInMemory(deps, subagent.value, target) : ok(null);
  if (!moved.ok) return moved;
  const saved = await saveSubagent(deps.subagents, subagent.value, new Map());
  if (!saved.ok) return saved;
  await deps.audit.record({
    actorId: cmd.actorId,
    action: 'subagent.restore',
    target: cmd.slug,
    meta: { version: subagent.value.currentVersion },
  });
  if (moved.value) {
    await deps.audit.record({
      actorId: cmd.actorId,
      action: 'subagent.move',
      target: cmd.slug,
      meta: moved.value,
    });
  }
  return ok(undefined);
}

/** Moves an active subagent to another active folder; no new version. */
export async function moveSubagent(
  deps: CatalogDeps,
  cmd: { slug: string; folder: string; actorId: string },
): Promise<Result<void, CatalogError>> {
  const subagent = await loadSubagent(deps.subagents, cmd.slug);
  if (!subagent.ok) return subagent;
  const target = await loadFolder(deps.folders, cmd.folder);
  if (!target.ok) return target;
  if (subagent.value.status === 'archived') {
    return err(new CatalogError('subagent_archived', `subagent "${cmd.slug}" is archived`));
  }
  const archived = archivedError(target.value);
  if (archived) return err(archived);
  const moved = await moveInMemory(deps, subagent.value, target.value);
  if (!moved.ok) return moved;
  if (!moved.value) return ok(undefined);
  const saved = await saveSubagent(deps.subagents, subagent.value, new Map());
  if (!saved.ok) return saved;
  await deps.audit.record({
    actorId: cmd.actorId,
    action: 'subagent.move',
    target: cmd.slug,
    meta: moved.value,
  });
  return ok(undefined);
}
