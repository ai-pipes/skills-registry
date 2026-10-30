import type { Sql } from '../../../platform/db.ts';
import type {
  OidcSubject,
  PendingLogin,
  PendingLoginRepository,
  SessionRecord,
  SessionRepository,
  TokenRecord,
  TokenRepository,
  UserRepository,
} from '../application/ports.ts';
import type { Role, User } from '../domain/user.ts';

interface UserRow {
  id: string;
  login: string;
  password_hash: string | null;
  role: Role;
  disabled: boolean;
  created_at: Date;
  oidc_iss: string | null;
  oidc_sub: string | null;
  email: string | null;
  groups: string[];
  last_login_at: Date | null;
}

const toUser = (r: UserRow): User => ({
  id: r.id,
  login: r.login,
  passwordHash: r.password_hash,
  role: r.role,
  disabled: r.disabled,
  createdAt: r.created_at,
  oidcIss: r.oidc_iss,
  oidcSub: r.oidc_sub,
  email: r.email,
  groups: r.groups,
  lastLoginAt: r.last_login_at,
});

export class PgUserRepository implements UserRepository {
  constructor(private readonly sql: Sql) {}

  async findByLogin(login: string): Promise<User | null> {
    const [r] = await this.sql<UserRow[]>`select * from identity.users where login = ${login}`;
    return r ? toUser(r) : null;
  }

  async findById(id: string): Promise<User | null> {
    if (!isUuid(id)) return null;
    const [r] = await this.sql<UserRow[]>`select * from identity.users where id = ${id}`;
    return r ? toUser(r) : null;
  }

  async count(): Promise<number> {
    const [r] = await this.sql<{ n: number }[]>`select count(*)::int as n from identity.users`;
    return r?.n ?? 0;
  }

  async insertIfEmpty(u: {
    login: string;
    passwordHash: string;
    role: Role;
    createdAt: Date;
  }): Promise<User | null> {
    // Under READ COMMITTED two concurrent `where not exists` inserts both pass; the
    // transaction-scoped advisory lock serialises bootstrap attempts.
    return this.sql.begin(async (tx) => {
      await tx`select pg_advisory_xact_lock(hashtext('identity.bootstrap'))`;
      const [r] = await tx<UserRow[]>`
        insert into identity.users (login, password_hash, role, created_at)
        select ${u.login}, ${u.passwordHash}, ${u.role}, ${u.createdAt}
        where not exists (select 1 from identity.users)
        on conflict (login) do nothing returning *`;
      return r ? toUser(r) : null;
    });
  }

  async list(): Promise<User[]> {
    const rows = await this.sql<UserRow[]>`select * from identity.users order by created_at, login`;
    return rows.map(toUser);
  }

  async insert(u: {
    login: string;
    passwordHash: string;
    role: Role;
    createdAt: Date;
  }): Promise<User | null> {
    const [r] = await this.sql<UserRow[]>`
      insert into identity.users (login, password_hash, role, created_at)
      values (${u.login}, ${u.passwordHash}, ${u.role}, ${u.createdAt})
      on conflict (login) do nothing returning *`;
    return r ? toUser(r) : null;
  }

  async loginsByIds(ids: string[]): Promise<Map<string, string>> {
    const valid = ids.filter(isUuid);
    if (valid.length === 0) return new Map();
    const rows = await this.sql<{ id: string; login: string }[]>`
      select id, login from identity.users where id = any(${valid}::uuid[])`;
    return new Map(rows.map((r) => [r.id, r.login]));
  }

  async setPasswordHash(id: string, passwordHash: string): Promise<boolean> {
    if (!isUuid(id)) return false;
    const r = await this.sql`update identity.users set password_hash = ${passwordHash}
      where id = ${id}`;
    return r.count > 0;
  }

  async setDisabled(id: string, disabled: boolean): Promise<boolean> {
    if (!isUuid(id)) return false;
    const r = await this.sql`update identity.users set disabled = ${disabled} where id = ${id}`;
    return r.count > 0;
  }

  async findBySubject(s: OidcSubject): Promise<User | null> {
    const [r] = await this.sql<UserRow[]>`
      select * from identity.users where oidc_iss = ${s.iss} and oidc_sub = ${s.sub}`;
    return r ? toUser(r) : null;
  }

  async insertSso(u: {
    login: string;
    subject: OidcSubject;
    email: string | null;
    groups: string[];
    role: Role;
    createdAt: Date;
  }): Promise<User | null> {
    // No conflict target: a taken login and a taken sub (concurrent first login) both yield null.
    const [r] = await this.sql<UserRow[]>`
      insert into identity.users (login, oidc_iss, oidc_sub, email, groups, role, created_at)
      values (${u.login}, ${u.subject.iss}, ${u.subject.sub}, ${u.email}, ${u.groups}, ${u.role},
        ${u.createdAt})
      on conflict do nothing returning *`;
    return r ? toUser(r) : null;
  }

  async recordSsoLogin(
    id: string,
    input: { email: string | null; groups: string[]; role: Role },
  ): Promise<User> {
    const [r] = await this.sql<UserRow[]>`
      update identity.users
      set email = ${input.email}, groups = ${input.groups}, role = ${input.role}
      where id = ${id} returning *`;
    if (!r) throw new Error('user to refresh not found');
    return toUser(r);
  }

  async setLastLogin(id: string, at: Date): Promise<void> {
    await this.sql`update identity.users set last_login_at = ${at} where id = ${id}`;
  }

  async setOidcSubject(id: string, s: OidcSubject | null): Promise<boolean> {
    if (!isUuid(id)) return false;
    const r = await this.sql`update identity.users
      set oidc_iss = ${s?.iss ?? null}, oidc_sub = ${s?.sub ?? null} where id = ${id}`;
    return r.count > 0;
  }
}

interface PendingRow {
  state: string;
  code_verifier: string;
  nonce: string;
  return_to: string;
  expires_at: Date;
}

export class PgPendingLoginRepository implements PendingLoginRepository {
  constructor(private readonly sql: Sql) {}

  async insert(p: PendingLogin): Promise<void> {
    // Expired attempts are dropped here, so the table never needs a separate sweeper.
    await this.sql`delete from identity.oidc_pending where expires_at <= now()`;
    await this
      .sql`insert into identity.oidc_pending (state, code_verifier, nonce, return_to, expires_at)
      values (${p.state}, ${p.codeVerifier}, ${p.nonce}, ${p.returnTo}, ${p.expiresAt})`;
  }

  async consume(state: string): Promise<PendingLogin | null> {
    const [r] = await this.sql<PendingRow[]>`
      delete from identity.oidc_pending where state = ${state} returning *`;
    return r
      ? {
          state: r.state,
          codeVerifier: r.code_verifier,
          nonce: r.nonce,
          returnTo: r.return_to,
          expiresAt: r.expires_at,
        }
      : null;
  }
}

interface TokenRow {
  id: string;
  user_id: string;
  name: string;
  prefix: string;
  hash: string;
  created_at: Date;
  last_used_at: Date | null;
  revoked_at: Date | null;
}

const toToken = (r: TokenRow): TokenRecord => ({
  id: r.id,
  userId: r.user_id,
  name: r.name,
  prefix: r.prefix,
  hash: r.hash,
  createdAt: r.created_at,
  lastUsedAt: r.last_used_at,
  revokedAt: r.revoked_at,
});

export class PgTokenRepository implements TokenRepository {
  constructor(private readonly sql: Sql) {}

  async insert(t: Omit<TokenRecord, 'id' | 'lastUsedAt' | 'revokedAt'>): Promise<TokenRecord> {
    const [r] = await this.sql<TokenRow[]>`
      insert into identity.api_tokens (user_id, name, prefix, hash, created_at)
      values (${t.userId}, ${t.name}, ${t.prefix}, ${t.hash}, ${t.createdAt}) returning *`;
    if (!r) throw new Error('token insert returned no row');
    return toToken(r);
  }

  async findByHash(hash: string): Promise<TokenRecord | null> {
    const [r] = await this.sql<TokenRow[]>`select * from identity.api_tokens where hash = ${hash}`;
    return r ? toToken(r) : null;
  }

  async findById(id: string): Promise<TokenRecord | null> {
    if (!isUuid(id)) return null;
    const [r] = await this.sql<TokenRow[]>`select * from identity.api_tokens where id = ${id}`;
    return r ? toToken(r) : null;
  }

  async listByUser(userId: string): Promise<TokenRecord[]> {
    const rows = await this.sql<TokenRow[]>`
      select * from identity.api_tokens where user_id = ${userId} order by created_at desc`;
    return rows.map(toToken);
  }

  async revoke(id: string, at: Date): Promise<void> {
    await this.sql`update identity.api_tokens set revoked_at = ${at}
      where id = ${id} and revoked_at is null`;
  }

  async revokeAllByUser(userId: string, at: Date): Promise<void> {
    await this.sql`update identity.api_tokens set revoked_at = ${at}
      where user_id = ${userId} and revoked_at is null`;
  }

  async touch(id: string, at: Date): Promise<void> {
    await this.sql`update identity.api_tokens set last_used_at = ${at} where id = ${id}`;
  }
}

interface SessionRow {
  id_hash: string;
  user_id: string;
  created_at: Date;
  last_seen_at: Date;
  expires_at: Date;
}

export class PgSessionRepository implements SessionRepository {
  constructor(private readonly sql: Sql) {}

  async insert(s: SessionRecord): Promise<void> {
    await this
      .sql`insert into identity.sessions (id_hash, user_id, created_at, last_seen_at, expires_at)
      values (${s.idHash}, ${s.userId}, ${s.createdAt}, ${s.lastSeenAt}, ${s.expiresAt})`;
  }

  async findByHash(idHash: string): Promise<SessionRecord | null> {
    const [r] = await this.sql<SessionRow[]>`
      select * from identity.sessions where id_hash = ${idHash}`;
    return r
      ? {
          idHash: r.id_hash,
          userId: r.user_id,
          createdAt: r.created_at,
          lastSeenAt: r.last_seen_at,
          expiresAt: r.expires_at,
        }
      : null;
  }

  async touch(idHash: string, at: Date): Promise<void> {
    await this.sql`update identity.sessions set last_seen_at = ${at} where id_hash = ${idHash}`;
  }

  async delete(idHash: string): Promise<void> {
    await this.sql`delete from identity.sessions where id_hash = ${idHash}`;
  }

  async deleteByUser(userId: string): Promise<void> {
    await this.sql`delete from identity.sessions where user_id = ${userId}`;
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// ids come from the outside (URLs); a malformed one must be "not found", not a 500
function isUuid(s: string): boolean {
  return UUID.test(s);
}
