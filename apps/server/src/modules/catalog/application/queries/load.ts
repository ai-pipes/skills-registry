import { err, ok, type Result } from '../../../../shared-kernel/index.ts';
import { CatalogError } from '../../domain/errors.ts';
import type { Skill, SkillVersion } from '../../domain/skill.ts';
import { Slug } from '../../domain/slug.ts';
import type { Subagent, SubagentVersion } from '../../domain/subagent.ts';
import type { SkillRepository, SubagentRepository } from '../ports.ts';

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

export async function loadSubagent(
  subagents: SubagentRepository,
  rawSlug: string,
): Promise<Result<Subagent, CatalogError>> {
  const slug = Slug.parse(rawSlug);
  if (!slug.ok) return slug;
  const subagent = await subagents.findBySlug(slug.value);
  if (!subagent) {
    return err(new CatalogError('subagent_not_found', `subagent "${rawSlug}" not found`));
  }
  return ok(subagent);
}

export async function loadSubagentVersion(
  subagents: SubagentRepository,
  subagent: Subagent,
  version: number | undefined,
): Promise<Result<SubagentVersion, CatalogError>> {
  if (version === undefined || version === subagent.currentVersion) return ok(subagent.latest);
  const found = await subagents.getVersion(subagent.id, version);
  if (!found) return err(new CatalogError('version_not_found', `version ${version} not found`));
  return ok(found);
}
