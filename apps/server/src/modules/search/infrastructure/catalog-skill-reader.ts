import { type CatalogDeps, getSkill, listSkills } from '../../catalog/index.ts';
import type { SkillReader } from '../application/ports.ts';

/** SkillReader over Catalog's public queries (never Catalog tables). */
export function createCatalogSkillReader(
  catalog: Pick<CatalogDeps, 'skills' | 'blobs' | 'folders'>,
): SkillReader {
  return {
    async get(slug) {
      const res = await getSkill(catalog, { slug });
      if (!res.ok) {
        if (res.error.code === 'skill_not_found') return null;
        throw res.error;
      }
      const v = res.value;
      return {
        slug: v.slug,
        name: v.name,
        description: v.description,
        skillMd: v.skillMd,
        status: v.status,
        version: v.version,
        folder: v.folder.slug,
      };
    },
    async listSlugs() {
      return (await listSkills(catalog, { status: 'all' })).map((s) => s.slug);
    },
  };
}
