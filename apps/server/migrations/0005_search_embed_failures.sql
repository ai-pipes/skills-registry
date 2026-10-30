-- A document whose embedding keeps failing (a "poison" document) must not block the recovery
-- sweep: the sweep marks it here and skips it for an hour. Cleared by a successful embedding.
alter table search.documents add column embed_failed_at timestamptz;
