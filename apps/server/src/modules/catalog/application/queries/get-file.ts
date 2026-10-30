import { err, ok, type Result } from '../../../../shared-kernel/index.ts';
import { CatalogError } from '../../domain/errors.ts';
import { FilePath } from '../../domain/file-path.ts';
import type { CatalogDeps } from '../deps.ts';
import { loadSkill, loadVersion } from './load.ts';

export async function getSkillFile(
  deps: Pick<CatalogDeps, 'skills' | 'blobs'>,
  q: { slug: string; path: string; version?: number },
): Promise<
  Result<{ path: string; size: number; binary: boolean; bytes: Uint8Array }, CatalogError>
> {
  const skill = await loadSkill(deps.skills, q.slug);
  if (!skill.ok) return skill;
  const path = FilePath.parse(q.path);
  if (!path.ok) return path;
  const version = await loadVersion(deps.skills, skill.value, q.version);
  if (!version.ok) return version;
  const entry = version.value.manifest.get(path.value);
  const notFound = () =>
    err(new CatalogError('file_not_found', `file "${path.value.value}" not found`));
  if (!entry) return notFound();
  const bytes = await deps.blobs.get(entry.hash);
  if (!bytes) return notFound();
  return ok({ path: entry.path.value, size: entry.size, binary: entry.binary, bytes });
}
