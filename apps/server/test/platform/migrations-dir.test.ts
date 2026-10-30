import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vite-plus/test';
import { findMigrationsDir } from '../../src/platform/migrate.ts';
import { migrationsDir } from '../pg.ts';

describe('findMigrationsDir', () => {
  it('finds apps/server/migrations from the source entry point', () => {
    const entry = new URL('../../src/platform/main.ts', import.meta.url).href;
    expect(findMigrationsDir(entry)).toBe(migrationsDir);
  });

  it('finds it one level up from a bundle in dist/', async () => {
    const root = await mkdtemp(join(tmpdir(), 'migrations-dir-'));
    try {
      await mkdir(join(root, 'migrations'));
      await mkdir(join(root, 'dist'));
      const entry = pathToFileURL(join(root, 'dist', 'main.js')).href;
      expect(findMigrationsDir(entry)).toBe(join(root, 'migrations'));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('throws when there is none', () => {
    expect(() => findMigrationsDir('file:///no-such-root/x/main.js')).toThrow(/no migrations/);
  });
});
