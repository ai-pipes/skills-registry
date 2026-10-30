create schema if not exists search;

-- Read model of the latest active version of each skill, keyed by slug (unique and immutable in
-- Catalog). Archived skills have no row. `embedding` is null until the embedder has run.
create table search.documents (
  slug text primary key,
  name text not null,
  description text not null,
  version int not null,
  fts tsvector not null,
  embedding vector(384),
  updated_at timestamptz not null default now()
);

create index documents_fts_idx on search.documents using gin (fts);
create index documents_embedding_idx on search.documents using hnsw (embedding vector_cosine_ops);
