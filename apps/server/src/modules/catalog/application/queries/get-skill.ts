import { err, ok, type Result } from '../../../../shared-kernel/index.ts';
import { CatalogError } from '../../domain/errors.ts';
import { FilePath } from '../../domain/file-path.ts';
import type { SkillStatus } from '../../domain/skill.ts';
import type { SkillSource } from '../../domain/source.ts';
import type { CatalogDeps } from '../deps.ts';
import type { FolderRef } from '../ports.ts';
import { loadSkill, loadVersion } from './load.ts';

export type SkillView = {
  slug: string;
  version: number;
  name: string;
  description: string;
  status: SkillStatus;
  skillMd: string;
  skillMdSha256: string;
  files: { path: string; size: number; binary: boolean; sha256: string }[];
  updatedAt: Date;
  folder: FolderRef;
  /** Where the skill was imported from; null for a skill made in the registry. */
  source: SkillSource | null;
  /** The upstream commit of the shown version; null when it was not taken from upstream. */
  sourceCommit: string | null;
};

export async function getSkill(
  deps: Pick<CatalogDeps, 'skills' | 'blobs' | 'folders'>,
  q: { slug: string; version?: number },
): Promise<Result<SkillView, CatalogError>> {
  const skill = await loadSkill(deps.skills, q.slug);
  if (!skill.ok) return skill;
  const version = await loadVersion(deps.skills, skill.value, q.version);
  if (!version.ok) return version;
  const v = version.value;
  const mdEntry = v.manifest.entries.find((e) => e.path.value === FilePath.SKILL_MD);
  const bytes = mdEntry ? await deps.blobs.get(mdEntry.hash) : null;
  if (!mdEntry || !bytes) {
    return err(new CatalogError('file_not_found', 'SKILL.md content is missing'));
  }
  const folder = await deps.folders.findById(skill.value.folderId);
  if (!folder) throw new Error(`folder ${skill.value.folderId} of skill "${q.slug}" is missing`);
  return ok({
    slug: skill.value.slug.value,
    version: v.number,
    name: v.name,
    description: v.description,
    status: skill.value.status,
    skillMd: new TextDecoder().decode(bytes),
    skillMdSha256: mdEntry.hash.value,
    files: v.manifest.entries
      .filter((e) => e.path.value !== FilePath.SKILL_MD)
      .map((e) => ({ path: e.path.value, size: e.size, binary: e.binary, sha256: e.hash.value })),
    updatedAt: skill.value.updatedAt,
    folder: { slug: folder.slug.value, name: folder.name },
    source: skill.value.source,
    sourceCommit: v.sourceCommit,
  });
}
