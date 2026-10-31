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

export type SubagentSource = {
  slug: string;
  name: string;
  description: string;
  /** SUBAGENT.md without its frontmatter: the system prompt. */
  body: string;
  status: 'active' | 'archived';
  version: number;
  /** Slug of the subagent's folder. */
  folder: string;
};

/** Read access to Catalog subagents (latest version), implemented over Catalog's public API. */
export interface SubagentReader {
  get(slug: string): Promise<SubagentSource | null>;
  /** Slugs of every subagent in the catalog, active and archived. */
  listSlugs(): Promise<string[]>;
}

/** What a search document describes. A skill and a subagent may share a slug. */
export type DocumentKind = 'skill' | 'subagent';

export type DocumentRef = { kind: DocumentKind; slug: string };

export type IndexedDocument = {
  kind: DocumentKind;
  slug: string;
  name: string;
  description: string;
  version: number;
  body: string;
  /** Slug of the document's folder. */
  folder: string;
  embedding: number[] | null;
};

export type DocumentSummary = { slug: string; name: string; description: string; folder: string };

/** Documents are keyed by (kind, slug); every query is limited to one kind. */
export interface SearchIndex {
  /** Inserts or replaces the document of (`doc.kind`, `doc.slug`). */
  upsert(doc: IndexedDocument): Promise<void>;
  remove(kind: DocumentKind, slug: string): Promise<void>;
  slugs(kind: DocumentKind): Promise<string[]>;
  /**
   * Up to `limit` documents of either kind stored without an embedding, never-attempted first
   * (then by kind and slug), skipping those whose embedding failed within the last hour.
   */
  slugsWithoutEmbedding(limit: number): Promise<DocumentRef[]>;
  /**
   * Records that embedding the document failed, so the sweep skips it for a while.
   * A successful upsert with an embedding clears the mark.
   */
  markEmbedFailed(kind: DocumentKind, slug: string): Promise<void>;
  /**
   * Slugs of `kind` ranked by full-text relevance, best first. The kind, and `folders` (slugs)
   * when non-null, filter before `limit` is applied.
   */
  ftsCandidates(
    kind: DocumentKind,
    query: string,
    limit: number,
    folders: string[] | null,
  ): Promise<string[]>;
  /**
   * Slugs of `kind` whose cosine similarity to `embedding` is at least `minSimilarity`, nearest
   * first. Without the floor every query would return the whole index in some order. The kind,
   * and `folders` when non-null, filter before `limit` is applied.
   */
  vectorCandidates(
    kind: DocumentKind,
    embedding: number[],
    limit: number,
    minSimilarity: number,
    folders: string[] | null,
  ): Promise<string[]>;
  summaries(kind: DocumentKind, slugs: string[]): Promise<DocumentSummary[]>;
}

export type SearchDeps = {
  index: SearchIndex;
  embedder: Embedder;
  skills: SkillReader;
  subagents: SubagentReader;
  /** Cosine-similarity floor τ for vector candidates (SEARCH_MIN_SIMILARITY). */
  minSimilarity: number;
};
