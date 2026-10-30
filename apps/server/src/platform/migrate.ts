import { existsSync } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Sql } from './db.ts';

const MIGRATION_FILE = /^\d{4}_.+\.sql$/;
const LOCK_KEY = 727001;

/**
 * The nearest `migrations/` directory above `moduleUrl`. Entry points pass their own
 * `import.meta.url`, which works both from source (src/platform/) and from the bundle (dist/).
 */
export function findMigrationsDir(moduleUrl: string): string {
  let dir = dirname(fileURLToPath(moduleUrl));
  for (;;) {
    const candidate = join(dir, 'migrations');
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) throw new Error(`no migrations directory above ${moduleUrl}`);
    dir = parent;
  }
}

export async function migrate(sql: Sql, dir: string): Promise<string[]> {
  const files = (await readdir(dir)).filter((f) => MIGRATION_FILE.test(f)).toSorted();
  const applied: string[] = [];
  // Session-level advisory lock on a reserved connection spans the whole run,
  // while each migration file gets its own transaction.
  const conn = await sql.reserve();
  try {
    await conn`select pg_advisory_lock(${LOCK_KEY})`;
    try {
      await conn`create schema if not exists platform`;
      await conn`create table if not exists platform.schema_migrations (
        name text primary key,
        applied_at timestamptz not null default now()
      )`;
      const done = new Set(
        (await conn<{ name: string }[]>`select name from platform.schema_migrations`).map(
          (r) => r.name,
        ),
      );
      await files
        .filter((file) => !done.has(file))
        .reduce(async (prev, file) => {
          await prev;
          const text = await readFile(join(dir, file), 'utf8');
          await conn.unsafe('begin');
          try {
            await conn.unsafe(text);
            await conn`insert into platform.schema_migrations (name) values (${file})`;
            await conn.unsafe('commit');
          } catch (error) {
            await conn.unsafe('rollback');
            throw error;
          }
          applied.push(file);
        }, Promise.resolve());
    } finally {
      await conn`select pg_advisory_unlock(${LOCK_KEY})`;
    }
  } finally {
    conn.release();
  }
  return applied;
}
