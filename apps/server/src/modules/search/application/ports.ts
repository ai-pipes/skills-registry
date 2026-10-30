export interface Embedder {
  readonly dimensions: 384;
  embedPassages(texts: string[]): Promise<number[][]>;
  embedQuery(text: string): Promise<number[]>;
  /** True once the model is usable; must not block on a model download. */
  ready(): Promise<boolean>;
}

export type SkillSource = {
  slug: string;
  name: string;
  description: string;
  skillMd: string;
  status: 'active' | 'archived';
  version: number;
  /** Slug of the skill's folder. */
  folder: string;
};

/** Read access to Catalog skills (latest version), implemented over Catalog's public API. */
export interface SkillReader {
  get(slug: string): Promise<SkillSource | null>;
  /** Slugs of every skill in the catalog, active and archived. */
  listSlugs(): Promise<string[]>;
}

export type IndexedDocument = {
  slug: string;
  name: string;
  description: string;
  version: number;
  body: string;
  /** Slug of the skill's folder. */
  folder: string;
  embedding: number[] | null;
};

export type DocumentSummary = { slug: string; name: string; description: string; folder: string };

export interface SearchIndex {
  upsert(doc: IndexedDocument): Promise<void>;
  remove(slug: string): Promise<void>;
  slugs(): Promise<string[]>;
  /**
   * Up to `limit` slugs of documents stored without an embedding, never-attempted first (then
   * by slug), skipping those whose embedding failed within the last hour.
   */
  slugsWithoutEmbedding(limit: number): Promise<string[]>;
  /**
   * Records that embedding `slug` failed, so the sweep skips it for a while.
   * A successful upsert with an embedding clears the mark.
   */
  markEmbedFailed(slug: string): Promise<void>;
  /**
   * Slugs ranked by full-text relevance, best first. `folders` (slugs) non-null → only documents
   * in those folders, filtered before `limit` is applied.
   */
  ftsCandidates(query: string, limit: number, folders: string[] | null): Promise<string[]>;
  /**
   * Slugs whose cosine similarity to `embedding` is at least `minSimilarity`, nearest first.
   * Without the floor every query would return the whole index in some order. `folders`
   * non-null → only documents in those folders, filtered before `limit` is applied.
   */
  vectorCandidates(
    embedding: number[],
    limit: number,
    minSimilarity: number,
    folders: string[] | null,
  ): Promise<string[]>;
  summaries(slugs: string[]): Promise<DocumentSummary[]>;
}

export type SearchDeps = {
  index: SearchIndex;
  embedder: Embedder;
  skills: SkillReader;
  /** Cosine-similarity floor τ for vector candidates (SEARCH_MIN_SIMILARITY). */
  minSimilarity: number;
};
