import type { Sql } from '../../platform/db.ts';
import type { SearchDeps } from './application/ports.ts';
import { PgSearchIndex } from './infrastructure/pg-search-index.ts';

export { searchEventHandlers, type EventHandler } from './application/event-handlers.ts';
export { indexMissingEmbeddings } from './application/index-missing-embeddings.ts';
export { indexSkill } from './application/index-skill.ts';
export type { Embedder, SearchDeps, SkillReader } from './application/ports.ts';
export { reindexAll } from './application/reindex-all.ts';
export {
  DEFAULT_MIN_SIMILARITY,
  searchSkills,
  type SearchHit,
} from './application/search-skills.ts';
export { createCatalogSkillReader } from './infrastructure/catalog-skill-reader.ts';
export { OpenAiCompatibleEmbedder } from './infrastructure/openai-compatible-embedder.ts';
export { TransformersEmbedder } from './infrastructure/transformers-embedder.ts';

export function createPgSearch(sql: Sql): Pick<SearchDeps, 'index'> {
  return { index: new PgSearchIndex(sql) };
}
