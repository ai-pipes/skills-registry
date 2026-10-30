create extension if not exists citext;

create schema if not exists identity;

create table identity.users (
  id uuid primary key default gen_random_uuid(),
  login citext not null unique,
  password_hash text not null,
  role text not null check (role in ('admin', 'member')),
  disabled boolean not null default false,
  created_at timestamptz not null default now()
);

create table identity.api_tokens (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references identity.users (id) on delete cascade,
  name text not null,
  prefix text not null,
  hash char(64) not null unique,
  created_at timestamptz not null default now(),
  last_used_at timestamptz,
  revoked_at timestamptz
);

create index api_tokens_user_idx on identity.api_tokens (user_id);

create table identity.sessions (
  id_hash char(64) primary key,
  user_id uuid not null references identity.users (id) on delete cascade,
  created_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  expires_at timestamptz not null
);

create index sessions_user_idx on identity.sessions (user_id);
