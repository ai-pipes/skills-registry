-- Single sign-on (OIDC). Users created by SSO have no password; `oidc_sub` links a user to the
-- provider account (null = not linked). Login stays the unique, displayed name.
alter table identity.users alter column password_hash drop not null;
alter table identity.users add column oidc_sub text unique;
alter table identity.users add column email text;
alter table identity.users add column groups text[] not null default '{}';
alter table identity.users add column last_login_at timestamptz;

-- A started OIDC login (state → PKCE verifier, nonce, where to go after). One-time, short-lived.
create table identity.oidc_pending (
  state text primary key,
  code_verifier text not null,
  nonce text not null,
  return_to text not null,
  expires_at timestamptz not null
);

create index oidc_pending_expires_idx on identity.oidc_pending (expires_at);
