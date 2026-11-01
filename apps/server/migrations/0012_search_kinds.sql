-- Search documents of both Catalog kinds: skills and subagents share one table and the same
-- hybrid search, keyed by (kind, slug) because a skill and a subagent may share a slug.
-- Every existing row is a skill.
alter table search.documents
  add column kind text not null default 'skill' check (kind in ('skill', 'subagent'));
alter table search.documents alter column kind drop default;

alter table search.documents drop constraint documents_pkey;
alter table search.documents add primary key (kind, slug);
