-- Single sign-on (OIDC). Users created by SSO have no password; (`oidc_iss`, `oidc_sub`) links a
-- user to a provider account (both null = not linked): `sub` is unique only within its issuer, so
-- a new OIDC_ISSUER never lands on accounts of the old one. Login stays the unique, displayed name.
alter table identity.users alter column password_hash drop not null;
alter table identity.users add column oidc_iss text;
alter table identity.users add column oidc_sub text;
alter table identity.users add constraint users_oidc_subject_key unique (oidc_iss, oidc_sub);
alter table identity.users add constraint users_oidc_subject_check
  check ((oidc_iss is null) = (oidc_sub is null));
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
