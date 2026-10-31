-- Subagents: a separate aggregate next to skills. Its own slug namespace (a skill and a subagent
-- may share a slug); every subagent lives in exactly one folder. A version's single SUBAGENT.md is
-- a blob in catalog.blobs; `tools` null means "inherit every tool".
create table catalog.subagents (
  id uuid primary key,
  slug text not null unique,
  folder_id uuid not null references catalog.folders(id),
  status text not null check (status in ('active', 'archived')),
  current_version int not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index subagents_folder_idx on catalog.subagents (folder_id);

create table catalog.subagent_versions (
  subagent_id uuid not null references catalog.subagents(id),
  number int not null,
  name text not null,
  description text not null,
  tools text[],
  model text not null check (model in ('inherit', 'sonnet', 'opus', 'haiku')),
  skills text[] not null,
  content_hash char(64) not null references catalog.blobs(hash),
  size int not null,
  author_id uuid not null,
  message text,
  created_at timestamptz not null,
  restored_from int,
  primary key (subagent_id, number)
);

-- usedBy: which subagents list a skill (`skills @> array[slug]`).
create index subagent_versions_skills_idx on catalog.subagent_versions using gin (skills);
