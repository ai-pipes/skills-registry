import { err, ok, type Result } from '../../../../shared-kernel/index.ts';
import { CatalogError } from '../../domain/errors.ts';
import { Slug } from '../../domain/slug.ts';
import type { CatalogDeps } from '../deps.ts';
import { saveSkill } from '../save.ts';

export async function rollbackSkill(
  deps: CatalogDeps,
  cmd: { slug: string; toVersion: number; baseVersion: number; actorId: string },
): Promise<Result<{ slug: string; version: number }, CatalogError>> {
  const slug = Slug.parse(cmd.slug);
  if (!slug.ok) return slug;
  const skill = await deps.skills.findBySlug(slug.value);
  if (!skill) return err(new CatalogError('skill_not_found', `skill "${cmd.slug}" not found`));
  const notFound = () =>
    err(new CatalogError('version_not_found', `version ${cmd.toVersion} cannot be rolled back to`));
  if (
    !Number.isInteger(cmd.toVersion) ||
    cmd.toVersion < 1 ||
    cmd.toVersion >= skill.currentVersion
  ) {
    return notFound();
  }
  const target = await deps.skills.getVersion(skill.id, cmd.toVersion);
  if (!target) return notFound();
  const rolled = skill.rollback({
    toVersion: target,
    baseVersion: cmd.baseVersion,
    authorId: cmd.actorId,
    now: deps.clock.now(),
  });
  if (!rolled.ok) return rolled;
  // Blobs of the target version are already stored.
  const saved = await saveSkill(deps.skills, skill, new Map());
  if (!saved.ok) return saved;
  const version = rolled.value.number;
  await deps.audit.record({
    actorId: cmd.actorId,
    action: 'skill.rollback',
    target: cmd.slug,
    meta: { version },
  });
  return ok({ slug: cmd.slug, version });
}
