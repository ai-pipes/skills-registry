import { err, ok, type Result } from '../../../shared-kernel/index.ts';
import { CatalogError } from '../domain/errors.ts';
import type { Skill } from '../domain/skill.ts';
import type { SkillRepository } from './ports.ts';

/** Translates repository CatalogErrors (version_conflict, skill_exists) into Results; rethrows the rest. */
export async function saveSkill(
  skills: SkillRepository,
  skill: Skill,
  blobs: Map<string, Uint8Array>,
): Promise<Result<void, CatalogError>> {
  try {
    await skills.save(skill, blobs);
    return ok(undefined);
  } catch (cause) {
    if (cause instanceof CatalogError) return err(cause);
    throw cause;
  }
}
