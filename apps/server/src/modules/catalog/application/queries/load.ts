import { err, ok, type Result } from '../../../../shared-kernel/index.ts';
import { CatalogError } from '../../domain/errors.ts';
import type { Skill, SkillVersion } from '../../domain/skill.ts';
import { Slug } from '../../domain/slug.ts';
import type { SkillRepository } from '../ports.ts';

export async function loadSkill(
  skills: SkillRepository,
  rawSlug: string,
): Promise<Result<Skill, CatalogError>> {
  const slug = Slug.parse(rawSlug);
  if (!slug.ok) return slug;
  const skill = await skills.findBySlug(slug.value);
  if (!skill) return err(new CatalogError('skill_not_found', `skill "${rawSlug}" not found`));
  return ok(skill);
}

export async function loadVersion(
  skills: SkillRepository,
  skill: Skill,
  version: number | undefined,
): Promise<Result<SkillVersion, CatalogError>> {
  if (version === undefined || version === skill.currentVersion) return ok(skill.latest);
  const found = await skills.getVersion(skill.id, version);
  if (!found) return err(new CatalogError('version_not_found', `version ${version} not found`));
  return ok(found);
}
