import { copyFile, mkdtemp, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vite-plus/test';
import { createDb } from '../../src/platform/db.ts';
import { migrate } from '../../src/platform/migrate.ts';
import { migrationsDir, startPg } from '../pg.ts';

let pg: Awaited<ReturnType<typeof startPg>>;
beforeAll(async () => {
  pg = await startPg();
});
afterAll(async () => {
  await pg.stop();
});

describe('migrate', () => {
  it('applies migrations once', async () => {
    expect(await migrate(pg.sql, migrationsDir)).toEqual([]);
    const rows = await pg.sql`select name from platform.schema_migrations`;
    expect(rows.map((r) => r.name)).toContain('0001_platform.sql');
    expect(rows.map((r) => r.name)).toContain('0005_search_embed_failures.sql');
    expect(rows.map((r) => r.name)).toContain('0006_catalog_folders.sql');
    expect(rows.map((r) => r.name)).toContain('0007_search_folders.sql');
    expect(rows.map((r) => r.name)).toContain('0009_catalog_general_folder_english.sql');
  });

  it('0006 moves existing skills into the general folder', async () => {
    await pg.sql.unsafe('create database mig_folders');
    const dir = await mkdtemp(join(tmpdir(), 'mig-old-'));
    const old = (await readdir(migrationsDir)).filter((n) => /^000[1-5]_/.test(n));
    await Promise.all(old.map((f) => copyFile(join(migrationsDir, f), join(dir, f))));
    const u = new URL(pg.url);
    u.pathname = '/mig_folders';
    const sql = createDb(u.toString());
    try {
      await migrate(sql, dir);
      await sql`insert into catalog.skills (id, slug, status, current_version)
        values (gen_random_uuid(), 'old-skill', 'active', 1)`;
      await sql`insert into search.documents (slug, name, description, version, fts)
        values ('old-skill', 'old-skill', 'Old', 1, to_tsvector('simple', 'old'))`;
      await migrate(sql, migrationsDir);
      const skills = await sql`select folder_id from catalog.skills where slug = 'old-skill'`;
      expect(skills[0]?.folder_id).toBe('00000000-0000-4000-8000-000000000001');
      const folders = await sql`select slug, name, description, status from catalog.folders`;
      expect(folders).toHaveLength(1);
      expect({ ...folders[0] }).toEqual({
        slug: 'general',
        name: 'General',
        description: 'General skills without a specific topic',
        status: 'active',
      });
      const [col] = await sql`select is_nullable from information_schema.columns
        where table_schema = 'catalog' and table_name = 'skills' and column_name = 'folder_id'`;
      expect(col?.is_nullable).toBe('NO');
      const docs = await sql`select folder from search.documents where slug = 'old-skill'`;
      expect(docs[0]?.folder).toBe('general');
    } finally {
      await sql.end();
    }
  });

  it('0009 renames the general folder to English only while it is untouched', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'mig-0009-'));
    const old = (await readdir(migrationsDir)).filter((n) => /^000[1-8]_/.test(n));
    await Promise.all(old.map((f) => copyFile(join(migrationsDir, f), join(dir, f))));
    const run = async (
      db: string,
      edit: ((sql: ReturnType<typeof createDb>) => Promise<unknown>) | null,
    ) => {
      await pg.sql.unsafe(`create database ${db}`);
      const u = new URL(pg.url);
      u.pathname = `/${db}`;
      const sql = createDb(u.toString());
      try {
        await migrate(sql, dir);
        if (edit) await edit(sql);
        expect((await migrate(sql, migrationsDir))[0]).toBe(
          '0009_catalog_general_folder_english.sql',
        );
        const [row] =
          await sql`select name, description from catalog.folders where slug = 'general'`;
        return { ...row };
      } finally {
        await sql.end();
      }
    };
    expect(await run('mig_general_untouched', null)).toEqual({
      name: 'General',
      description: 'General skills without a specific topic',
    });
    // A name an admin already changed is kept, together with its description.
    expect(
      await run(
        'mig_general_edited',
        (sql) => sql`update catalog.folders set name = 'Misc' where slug = 'general'`,
      ),
    ).toEqual({ name: 'Misc', description: 'Общие skills без отдельной темы' });
  });

  it('enables pgvector', async () => {
    const rows = await pg.sql`select extname from pg_extension`;
    expect(rows.map((r) => r.extname)).toContain('vector');
  });

  it('applies each file in its own transaction', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'mig-'));
    await writeFile(join(dir, '0001_ok.sql'), 'create table platform.t_ok (id int);');
    await writeFile(join(dir, '0002_bad.sql'), 'this is not sql;');
    await expect(migrate(pg.sql, dir)).rejects.toThrow();
    const rows = await pg.sql`select name from platform.schema_migrations`;
    const names = rows.map((r) => r.name);
    expect(names).toContain('0001_ok.sql');
    expect(names).not.toContain('0002_bad.sql');
  });

  it('creates the platform and catalog schemas', async () => {
    const rows = await pg.sql`select schema_name from information_schema.schemata`;
    expect(rows.map((r) => r.schema_name)).toContain('platform');
    expect(rows.map((r) => r.schema_name)).toContain('catalog');
  });

  it('creates search.documents with FTS and HNSW indexes', async () => {
    const cols = await pg.sql<{ column_name: string; udt_name: string; is_nullable: string }[]>`
      select column_name, udt_name, is_nullable from information_schema.columns
      where table_schema = 'search' and table_name = 'documents' order by ordinal_position`;
    expect(cols.map((c) => [c.column_name, c.udt_name, c.is_nullable])).toEqual([
      ['slug', 'text', 'NO'],
      ['name', 'text', 'NO'],
      ['description', 'text', 'NO'],
      ['version', 'int4', 'NO'],
      ['fts', 'tsvector', 'NO'],
      ['embedding', 'vector', 'YES'],
      ['updated_at', 'timestamptz', 'NO'],
      ['embed_failed_at', 'timestamptz', 'YES'],
      ['folder', 'text', 'NO'],
    ]);
    const [dims] = await pg.sql<{ typmod: number }[]>`
      select atttypmod as typmod from pg_attribute
      where attrelid = 'search.documents'::regclass and attname = 'embedding'`;
    expect(dims?.typmod).toBe(384);
    const indexes = await pg.sql<{ indexdef: string }[]>`
      select indexdef from pg_indexes where schemaname = 'search' and tablename = 'documents'`;
    const defs = indexes.map((i) => i.indexdef);
    expect(defs.some((d) => /USING gin \(fts\)/.test(d))).toBe(true);
    expect(defs.some((d) => /USING hnsw \(embedding vector_cosine_ops\)/.test(d))).toBe(true);
    expect(
      defs.some((d) => /documents_folder_idx ON search\.documents USING btree \(folder\)/.test(d)),
    ).toBe(true);
  });

  it('0010 keeps existing password users unlinked, with no groups', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'mig-0010-'));
    const old = (await readdir(migrationsDir)).filter((n) => /^000\d_/.test(n));
    await Promise.all(old.map((f) => copyFile(join(migrationsDir, f), join(dir, f))));
    await pg.sql.unsafe('create database mig_sso');
    const u = new URL(pg.url);
    u.pathname = '/mig_sso';
    const sql = createDb(u.toString());
    try {
      await migrate(sql, dir);
      await sql`insert into identity.users (login, password_hash, role) values ('root', 'h', 'admin')`;
      expect(await migrate(sql, migrationsDir)).toEqual(['0010_identity_sso.sql']);
      const [row] = await sql`
        select password_hash, oidc_sub, email, groups, last_login_at from identity.users`;
      expect({ ...row }).toEqual({
        password_hash: 'h',
        oidc_sub: null,
        email: null,
        groups: [],
        last_login_at: null,
      });
      // SSO users have no password; a provider account links to at most one user.
      await sql`insert into identity.users (login, role, oidc_sub) values ('anna', 'member', 's1')`;
      await expect(
        sql`insert into identity.users (login, role, oidc_sub) values ('anna2', 'member', 's1')`,
      ).rejects.toThrow(/unique/);
    } finally {
      await sql.end();
    }
  });
});
