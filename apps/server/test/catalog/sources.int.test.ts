import { createHash } from 'node:crypto';
import { ErrorBody, SkillView, VersionSummary } from '@skills/contracts';
import type { Hono } from 'hono';
import { z } from 'zod';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vite-plus/test';
import { bootstrapAdmin } from '../../src/modules/identity/index.ts';
import type { Config } from '../../src/platform/config.ts';
import { buildContainer } from '../../src/platform/container.ts';
import { createHttpApp } from '../../src/platform/http/app.ts';
import type { AppEnv } from '../../src/platform/http/env.ts';
import { createLogger } from '../../src/platform/logger.ts';
import { FakeEmbedder } from '../fakes/fake-embedder.ts';
import { startPg, truncateAll } from '../pg.ts';

const ORIGIN = 'http://skills.test';
const ADMIN_PW = 'admin-password-123';
const SHA1 = '1'.repeat(40);
const SHA2 = '2'.repeat(40);

let pg: Awaited<ReturnType<typeof startPg>>;
let app: Hono<AppEnv>;
let cookie: string;

const config: Config = {
  port: 3000,
  databaseUrl: 'postgres://unused',
  publicUrl: `${ORIGIN}/`,
  allowedHosts: [],
  trustProxy: false,
  trustProxyHops: 1,
  cookieSecure: true,
  sessionSecret: 's'.repeat(32),
  embedder: 'local',
  modelDir: '/nonexistent',
  searchMinSimilarity: 0.3,
  logLevel: 'info',
};

beforeAll(async () => {
  pg = await startPg();
});
afterAll(async () => {
  await pg.stop();
});
beforeEach(async () => {
  await truncateAll(pg.sql);
  const logger = createLogger('info', { write: () => {} });
  const container = buildContainer(config, pg.sql, { embedder: new FakeEmbedder(), logger });
  app = createHttpApp(container, { remoteAddress: () => '10.0.0.1' }).app;
  const boot = await bootstrapAdmin(container.identity, { login: 'admin', password: ADMIN_PW });
  if (!boot.ok) throw boot.error;
  const res = await app.request('/api/auth/login', {
    method: 'POST',
    headers: { origin: ORIGIN, 'content-type': 'application/json' },
    body: JSON.stringify({ login: 'admin', password: ADMIN_PW }),
  });
  const m = /sr_session=([^;]+)/.exec(res.headers.get('set-cookie') ?? '');
  if (!m?.[1]) throw new Error('no session cookie');
  cookie = m[1];
});

const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');

const skillMd = (slug: string, body: string) =>
  `---\nname: ${slug}\ndescription: Builds MCP servers.\n---\n${body}\n`;

function form(fields: Record<string, string>, files: Record<string, string>): FormData {
  const f = new FormData();
  for (const [k, v] of Object.entries(fields)) f.append(k, v);
  for (const [path, text] of Object.entries(files)) f.append(path, new File([text], path));
  return f;
}

async function call(method: string, path: string, body?: FormData): Promise<Response> {
  return app.request(path, {
    method,
    headers: { origin: ORIGIN, cookie: `sr_session=${cookie}` },
    ...(body ? { body } : {}),
  });
}

async function json<S extends z.ZodType>(res: Response, schema: S): Promise<z.output<S>> {
  return schema.parse(await res.json());
}

const imported = {
  slug: 'mcp-builder',
  folder: 'general',
  sourceHost: 'github.com',
  sourceRepo: 'anthropics/skills',
  sourcePath: 'skills/mcp-builder',
  sourceRef: 'main',
  sourceCommit: SHA1,
};

describe('skill source over REST', () => {
  it('POST with source fields → GET shows the source; PUT with sourceCommit syncs; history has commits', async () => {
    const created = await call(
      'POST',
      '/api/skills',
      form(imported, { 'SKILL.md': skillMd('mcp-builder', 'v1'), 'ref.md': 'ref' }),
    );
    expect(created.status).toBe(201);

    let view = await json(await call('GET', '/api/skills/mcp-builder'), SkillView);
    expect(view.source).toEqual({
      host: 'github.com',
      repo: 'anthropics/skills',
      path: 'skills/mcp-builder',
      ref: 'main',
      syncedVersion: 1,
    });
    expect(view.sourceCommit).toBe(SHA1);
    expect(view.skillMdSha256).toBe(sha256(skillMd('mcp-builder', 'v1')));
    expect(view.files).toEqual([{ path: 'ref.md', size: 3, binary: false, sha256: sha256('ref') }]);

    const synced = await call(
      'PUT',
      '/api/skills/mcp-builder',
      form({ baseVersion: '1', sourceCommit: SHA2 }, { 'SKILL.md': skillMd('mcp-builder', 'v2') }),
    );
    expect(synced.status).toBe(200);
    view = await json(await call('GET', '/api/skills/mcp-builder'), SkillView);
    expect(view.source?.syncedVersion).toBe(2);
    expect(view.sourceCommit).toBe(SHA2);
    expect(view.files).toEqual([]);

    const edited = await call(
      'PUT',
      '/api/skills/mcp-builder',
      form({ baseVersion: '2', keep: '["SKILL.md"]' }, {}),
    );
    expect(edited.status).toBe(200);
    view = await json(await call('GET', '/api/skills/mcp-builder'), SkillView);
    expect(view.source?.syncedVersion).toBe(2);
    expect(view.sourceCommit).toBeNull();
    const old = await json(await call('GET', '/api/skills/mcp-builder?version=1'), SkillView);
    expect(old.sourceCommit).toBe(SHA1);

    const history = await json(
      await call('GET', '/api/skills/mcp-builder/history'),
      z.array(VersionSummary),
    );
    expect(history.map((v) => [v.number, v.sourceCommit])).toEqual([
      [3, null],
      [2, SHA2],
      [1, SHA1],
    ]);
  });

  it('a skill at the repository root keeps an empty path and no ref', async () => {
    const { sourceRef: _, ...rest } = imported;
    const res = await call(
      'POST',
      '/api/skills',
      form({ ...rest, sourcePath: '' }, { 'SKILL.md': skillMd('mcp-builder', 'v1') }),
    );
    expect(res.status).toBe(201);
    const view = await json(await call('GET', '/api/skills/mcp-builder'), SkillView);
    expect(view.source).toEqual({
      host: 'github.com',
      repo: 'anthropics/skills',
      path: '',
      ref: null,
      syncedVersion: 1,
    });
  });

  it('a skill made in the registry has no source; PUT with sourceCommit is 409 not_imported', async () => {
    const res = await call(
      'POST',
      '/api/skills',
      form({ slug: 'local', folder: 'general' }, { 'SKILL.md': skillMd('local', 'v1') }),
    );
    expect(res.status).toBe(201);
    const view = await json(await call('GET', '/api/skills/local'), SkillView);
    expect(view.source).toBeNull();
    expect(view.sourceCommit).toBeNull();
    const put = await call(
      'PUT',
      '/api/skills/local',
      form({ baseVersion: '1', sourceCommit: SHA1 }, { 'SKILL.md': skillMd('local', 'v2') }),
    );
    expect(put.status).toBe(409);
    expect((await json(put, ErrorBody)).error.code).toBe('not_imported');
    const after = await json(await call('GET', '/api/skills/local'), SkillView);
    expect(after.version).toBe(1);
  });

  it('an invalid source is 422 invalid_source; a partial one is rejected', async () => {
    const bad = await call(
      'POST',
      '/api/skills',
      form({ ...imported, sourceRepo: 'nope' }, { 'SKILL.md': skillMd('mcp-builder', 'v1') }),
    );
    expect(bad.status).toBe(422);
    expect((await json(bad, ErrorBody)).error.code).toBe('invalid_source');
    const partial = await call(
      'POST',
      '/api/skills',
      form(
        { slug: 'mcp-builder', folder: 'general', sourceRepo: 'anthropics/skills' },
        { 'SKILL.md': skillMd('mcp-builder', 'v1') },
      ),
    );
    expect(partial.status).toBeGreaterThanOrEqual(400);
    expect(partial.status).toBeLessThan(500);
    expect((await call('GET', '/api/skills/mcp-builder')).status).toBe(404);
  });
});
