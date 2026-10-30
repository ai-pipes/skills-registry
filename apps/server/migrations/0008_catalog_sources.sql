alter table catalog.skill_versions add column source_commit text;

create table catalog.skill_sources (
  skill_id uuid primary key references catalog.skills(id),
  host text not null,
  repo text not null,
  path text not null,
  ref text,
  synced_version int not null
);
