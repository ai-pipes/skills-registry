import { ok, type Result } from '../../../../shared-kernel/index.ts';
import type { CatalogError } from '../../domain/errors.ts';
import type { CatalogDeps } from '../deps.ts';
import { loadSkill } from './load.ts';

export type VersionSummary = {
  number: number;
  authorId: string;
  message: string | null;
  createdAt: Date;
  restoredFrom: number | null;
  sourceCommit: string | null;
};

export async function getHistory(
  deps: Pick<CatalogDeps, 'skills'>,
  q: { slug: string },
): Promise<Result<VersionSummary[], CatalogError>> {
  const skill = await loadSkill(deps.skills, q.slug);
  if (!skill.ok) return skill;
  const versions = await deps.skills.listVersions(skill.value.id);
  return ok(
    versions
      .map((v) => ({
        number: v.number,
        authorId: v.authorId,
        message: v.message,
        createdAt: v.createdAt,
        restoredFrom: v.restoredFrom,
        sourceCommit: v.sourceCommit,
      }))
      .toSorted((a, b) => b.number - a.number),
  );
}
