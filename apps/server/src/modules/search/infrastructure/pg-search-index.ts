import type { Sql, Tx } from '../../../platform/db.ts';
import type { DocumentSummary, IndexedDocument, SearchIndex } from '../application/ports.ts';

const toVector = (v: number[]) => `[${v.join(',')}]`;

type Fragment = ReturnType<Sql>;

export class PgSearchIndex implements SearchIndex {
  constructor(private readonly sql: Sql) {}

  async upsert(d: IndexedDocument): Promise<void> {
    const embedding = d.embedding ? toVector(d.embedding) : null;
    await this.sql`
      insert into search.documents
        (slug, name, description, version, folder, fts, embedding, updated_at)
      values (
        ${d.slug}, ${d.name}, ${d.description}, ${d.version}, ${d.folder},
        setweight(to_tsvector('simple', ${d.slug} || ' ' || ${d.name}), 'A')
          || setweight(to_tsvector('russian', ${d.description}), 'B')
          || setweight(to_tsvector('english', ${d.description}), 'B')
          || setweight(to_tsvector('russian', ${d.body}), 'C')
          || setweight(to_tsvector('english', ${d.body}), 'C'),
        ${embedding}::vector,
        now()
      )
      on conflict (slug) do update set
        name = excluded.name,
        description = excluded.description,
        version = excluded.version,
        folder = excluded.folder,
        fts = excluded.fts,
        embedding = excluded.embedding,
        embed_failed_at = case when excluded.embedding is null
          then search.documents.embed_failed_at else null end,
        updated_at = excluded.updated_at`;
  }

  async remove(slug: string): Promise<void> {
    await this.sql`delete from search.documents where slug = ${slug}`;
  }

  async slugs(): Promise<string[]> {
    const rows = await this.sql<
      { slug: string }[]
    >`select slug from search.documents order by slug`;
    return rows.map((r) => r.slug);
  }

  async slugsWithoutEmbedding(limit: number): Promise<string[]> {
    const rows = await this.sql<{ slug: string }[]>`
      select slug from search.documents
      where embedding is null
        and (embed_failed_at is null or embed_failed_at < now() - interval '1 hour')
      order by embed_failed_at nulls first, slug limit ${limit}`;
    return rows.map((r) => r.slug);
  }

  async markEmbedFailed(slug: string): Promise<void> {
    await this.sql`update search.documents set embed_failed_at = now() where slug = ${slug}`;
  }

  /** `and <column> = any(folders)`, or nothing when every folder is searched. */
  private inFolders(column: Fragment, folders: string[] | null): Fragment {
    return folders === null ? this.sql`` : this.sql`and ${column} = any(${folders}::text[])`;
  }

  async ftsCandidates(query: string, limit: number, folders: string[] | null): Promise<string[]> {
    const rows = await this.sql<{ slug: string }[]>`
      with q as (
        select websearch_to_tsquery('russian', ${query})
          || websearch_to_tsquery('english', ${query})
          || websearch_to_tsquery('simple', ${query}) as q
      )
      select d.slug from search.documents d, q
      where d.fts @@ q.q ${this.inFolders(this.sql`d.folder`, folders)}
      order by ts_rank_cd(d.fts, q.q) desc, d.slug
      limit ${limit}`;
    return rows.map((r) => r.slug);
  }

  async vectorCandidates(
    embedding: number[],
    limit: number,
    minSimilarity: number,
    folders: string[] | null,
  ): Promise<string[]> {
    const q = toVector(embedding);
    // The inner query has a single sort key (the distance) so the HNSW index serves it; with
    // a folder filter, iterative scan keeps walking the graph until `limit` matching rows are
    // found instead of filtering the first ef_search neighbours (pgvector >= 0.8.0). τ and the
    // tie-break by slug apply outside. `<=>` is cosine distance, so similarity = 1 - distance.
    const run = (tx: Sql | Tx) => tx<{ slug: string }[]>`
      select slug from (
        select slug, embedding <=> ${q}::vector as distance from search.documents
        where embedding is not null ${this.inFolders(tx`folder`, folders)}
        order by embedding <=> ${q}::vector
        limit ${limit}
      ) nearest
      where 1 - distance >= ${minSimilarity}
      order by distance, slug`;
    const rows = folders
      ? await this.sql.begin(async (tx) => {
          await tx`set local hnsw.iterative_scan = relaxed_order`;
          return run(tx);
        })
      : await run(this.sql);
    return rows.map((r) => r.slug);
  }

  async summaries(slugs: string[]): Promise<DocumentSummary[]> {
    if (slugs.length === 0) return [];
    return this.sql<DocumentSummary[]>`
      select slug, name, description, folder from search.documents where slug = any(${slugs}::text[])`;
  }
}
