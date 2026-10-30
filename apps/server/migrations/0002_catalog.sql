create schema if not exists catalog;

create table catalog.skills (
  id uuid primary key,
  slug text not null unique,
  status text not null check (status in ('active', 'archived')),
  current_version int not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table catalog.skill_versions (
  skill_id uuid not null references catalog.skills(id),
  number int not null,
  name text not null,
  description text not null,
  author_id uuid not null,
  message text,
  created_at timestamptz not null,
  restored_from int,
  primary key (skill_id, number)
);

create table catalog.blobs (
  hash char(64) primary key,
  bytes bytea not null,
  size int not null
);

create table catalog.version_files (
  skill_id uuid not null,
  number int not null,
  path text not null,
  hash char(64) not null references catalog.blobs(hash),
  size int not null,
  "binary" boolean not null,
  primary key (skill_id, number, path),
  foreign key (skill_id, number) references catalog.skill_versions(skill_id, number)
);
