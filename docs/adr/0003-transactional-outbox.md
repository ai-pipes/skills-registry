# 0003. Transactional outbox for events between modules

## Context

Search must update its index after changes in Catalog (`SkillVersionCreated`, `SkillArchived`, `SkillRestored`). A direct call from Catalog would couple the modules and could lose an update: the DB write succeeded but indexing failed (or vice versa). A message broker is an extra service and an extra point of failure for a self-hosted installation.

## Decision

Catalog writes domain events to the `platform.outbox` table in the same transaction as the aggregate change. A worker in the same process reads unprocessed events (`FOR UPDATE SKIP LOCKED`) and delivers them to subscribers (Search); handlers are idempotent. On error the event stays and is retried. There is a command for a full reindex.

## Consequences

- At-least-once delivery: handlers must be idempotent.
- The search index is only eventually consistent with the catalog, with a small delay.
- No broker: Postgres is enough.
- Modules stay decoupled: Catalog does not know about Search.
