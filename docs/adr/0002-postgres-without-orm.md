# 0002. PostgreSQL without an ORM

## Context

The data is relational and versioned; we need full-text search (`tsvector`, `russian` + `english`), vector search (pgvector) and a transactional outbox. An ORM hides exactly the Postgres features Search is built on, and drags the data model into the domain. Each module owns its own DB schema.

## Decision

Use PostgreSQL + pgvector as the only storage (including blobs as `bytea`). Access goes through a thin query builder / SQL without an ORM (Kysely or similar, the implementer's choice), only in `infrastructure`. Schemas `catalog`, `search`, `identity` and the cross-cutting `platform`; other modules' tables are never read directly. Migrations are versioned SQL files applied at startup.

## Consequences

- Full access to Postgres features: FTS, pgvector, `FOR UPDATE SKIP LOCKED` for the outbox.
- The domain knows nothing about the schema: row ↔ aggregate mapping is written by hand in repositories.
- Integration tests run against a real Postgres (Testcontainers), not an in-memory fake.
- We need our own discipline for migrations and query result types.
