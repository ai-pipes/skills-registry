create extension if not exists vector;

create schema if not exists platform;

create table if not exists platform.schema_migrations (
  name text primary key,
  applied_at timestamptz not null default now()
);

create table platform.outbox (
  id bigserial primary key,
  type text not null,
  payload jsonb not null,
  created_at timestamptz not null default now(),
  next_attempt_at timestamptz not null default now(),
  attempts int not null default 0,
  last_error text,
  processed_at timestamptz
);

create index outbox_pending_idx on platform.outbox (processed_at, next_attempt_at);

create table platform.audit_log (
  id bigserial primary key,
  at timestamptz not null default now(),
  actor_id uuid,
  action text not null,
  target text,
  meta jsonb
);
