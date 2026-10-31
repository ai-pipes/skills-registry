import { type CatalogDeps, getSubagent, listSubagents } from '../../catalog/index.ts';
import type { SubagentReader } from '../application/ports.ts';
import { documentBody } from '../domain/search-document.ts';

/** SubagentReader over Catalog's public queries (never Catalog tables). */
export function createCatalogSubagentReader(
  catalog: Pick<CatalogDeps, 'subagents' | 'blobs' | 'folders'>,
): SubagentReader {
  return {
    async get(slug) {
      const res = await getSubagent(catalog, { slug });
      if (!res.ok) {
        if (res.error.code === 'subagent_not_found') return null;
        throw res.error;
      }
      const v = res.value;
      return {
        slug: v.slug,
        name: v.name,
        description: v.description,
        body: documentBody(v.content),
        status: v.status,
        version: v.version,
        folder: v.folder.slug,
      };
    },
    async listSlugs() {
      return (await listSubagents(catalog, { status: 'all' })).map((s) => s.slug);
    },
  };
}
