import type { SkillStatus } from '../../domain/skill.ts';
import type { CatalogDeps } from '../deps.ts';
import type { SkillSummary } from '../ports.ts';

export type { SkillSummary } from '../ports.ts';

/** `folder` is a folder slug; an unknown one lists nothing. */
export async function listSkills(
  deps: Pick<CatalogDeps, 'skills'>,
  q: { status: SkillStatus | 'all'; folder?: string },
): Promise<SkillSummary[]> {
  return deps.skills.listSummaries({ status: q.status, folder: q.folder ?? null });
}
