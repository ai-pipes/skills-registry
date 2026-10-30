import { ErrorBody, FolderSummary, SkillSummary } from '@skills/contracts';
import type { Hono } from 'hono';
import type { z } from 'zod';
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

let pg: Awaited<ReturnType<typeof startPg>>;
let app: Hono<AppEnv>;
let session: string;

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
  const res = await call('POST', '/api/auth/login', {
    body: { login: 'admin', password: ADMIN_PW },
    cookie: undefined,
  });
  session = /sr_session=([^;]+)/.exec(res.headers.get('set-cookie') ?? '')?.[1] ?? '';
});

type Opts = {
  body?: unknown;
  form?: FormData;
  cookie?: string | undefined;
  origin?: string | null;
};

function call(method: string, path: string, opts: Opts = {}): Promise<Response> {
  const headers: Record<string, string> = {};
  const origin = opts.origin === undefined ? ORIGIN : opts.origin;
  if (origin !== null) headers['origin'] = origin;
  if (opts.cookie) headers['cookie'] = `sr_session=${opts.cookie}`;
  let body: FormData | string | undefined;
  if (opts.form) body = opts.form;
  else if (opts.body !== undefined) {
    body = JSON.stringify(opts.body);
    headers['content-type'] = 'application/json';
  }
  return Promise.resolve(
    app.request(path, { method, headers, ...(body === undefined ? {} : { body }) }),
  );
}

const authed = (method: string, path: string, body?: unknown) =>
  call(method, path, { cookie: session, ...(body === undefined ? {} : { body }) });

async function errorCode(res: Response): Promise<string> {
  return ErrorBody.parse(await res.json()).error.code;
}

const devops = { slug: 'devops', name: 'DevOps', description: 'CI' };

const createSkillIn = (slug: string, folder: string) => {
  const form = new FormData();
  form.append('slug', slug);
  form.append('folder', folder);
  form.append(
    'SKILL.md',
    new File([`---\nname: ${slug}\ndescription: d\n---\nBody.\n`], 'SKILL.md'),
  );
  return call('POST', '/api/skills', { cookie: session, form });
};

const list = async (query = ''): Promise<z.output<typeof FolderSummary>[]> =>
  FolderSummary.array().parse(await (await authed('GET', `/api/folders${query}`)).json());

describe('folders API', () => {
  it('creates a folder; repeat is folder_exists', async () => {
    const res = await authed('POST', '/api/folders', devops);
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ slug: 'devops', name: 'DevOps' });
    const again = await authed('POST', '/api/folders', devops);
    expect(again.status).toBe(409);
    expect(await errorCode(again)).toBe('folder_exists');
  });

  it('validates input', async () => {
    const slug = await authed('POST', '/api/folders', { ...devops, slug: 'Bad Slug' });
    expect(slug.status).toBe(422);
    expect(await errorCode(slug)).toBe('invalid_slug');
    const name = await authed('POST', '/api/folders', { ...devops, name: ' ' });
    expect(name.status).toBe(422);
    expect(await errorCode(name)).toBe('invalid_folder');
    const missing = await authed('POST', '/api/folders', { slug: 'x', name: 'X' });
    // existing convention: invalid_request maps to 422 by its invalid_ prefix
    expect(missing.status).toBe(422);
    expect(await errorCode(missing)).toBe('invalid_request');
  });

  it('requires Origin and a session', async () => {
    const csrf = await call('POST', '/api/folders', {
      cookie: session,
      body: devops,
      origin: null,
    });
    expect(csrf.status).toBe(403);
    expect(await errorCode(csrf)).toBe('csrf');
    const anon = await call('GET', '/api/folders');
    expect(anon.status).toBe(401);
  });

  it('lists active folders by name; status=all includes archived', async () => {
    await authed('POST', '/api/folders', devops);
    await authed('POST', '/api/folders', { slug: 'aaa', name: 'Archive me', description: 'x' });
    await authed('POST', '/api/folders/aaa/archive');
    expect((await list()).map((f) => f.name)).toEqual(['DevOps', 'General']);
    const all = await list('?status=all');
    expect(all.map((f) => f.name)).toEqual(['Archive me', 'DevOps', 'General']);
    expect(all[0]?.status).toBe('archived');
  });

  it('PUT updates name and description; slug in body is ignored', async () => {
    await authed('POST', '/api/folders', devops);
    const res = await authed('PUT', '/api/folders/devops', {
      slug: 'other',
      name: 'Ops',
      description: 'New',
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ slug: 'devops', name: 'Ops' });
    expect((await list()).find((f) => f.slug === 'devops')?.description).toBe('New');
    expect((await authed('PUT', '/api/folders/nope', devops)).status).toBe(404);
  });

  it('archive cascades to active skills and is idempotent; restore leaves skills archived', async () => {
    await authed('POST', '/api/folders', devops);
    expect((await createSkillIn('deploy', 'devops')).status).toBe(201);
    const first = await authed('POST', '/api/folders/devops/archive');
    expect(first.status).toBe(200);
    expect(await first.json()).toEqual({ archivedSkills: 1 });
    expect(await (await authed('POST', '/api/folders/devops/archive')).json()).toEqual({
      archivedSkills: 0,
    });
    const restored = await authed('POST', '/api/folders/devops/restore');
    expect(restored.status).toBe(204);
    const skills = SkillSummary.array().parse(
      await (await authed('GET', '/api/skills?status=all&folder=devops')).json(),
    );
    expect(skills.map((s) => s.status)).toEqual(['archived']);
  });

  it('unknown folder is folder_not_found', async () => {
    const res = await Promise.all(
      ['archive', 'restore'].map((action) => authed('POST', `/api/folders/nope/${action}`)),
    );
    expect(res.map((r) => r.status)).toEqual([404, 404]);
    expect(await Promise.all(res.map(errorCode))).toEqual(['folder_not_found', 'folder_not_found']);
  });
});
