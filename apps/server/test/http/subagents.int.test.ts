import {
  ArchiveFolderResponse,
  CreatedToken,
  ErrorBody,
  SkillView,
  SubagentDiff,
  SubagentSummary,
  SubagentVersionSummary,
  SubagentView,
  VersionRef,
} from '@skills/contracts';
import type { Hono } from 'hono';
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
let token: string;

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

type Opts = {
  body?: unknown;
  form?: FormData;
  cookie?: string;
  bearer?: string;
  origin?: string | null;
};

function call(method: string, path: string, opts: Opts = {}): Promise<Response> {
  const headers: Record<string, string> = {};
  const origin = opts.origin === undefined ? ORIGIN : opts.origin;
  if (origin !== null) headers['origin'] = origin;
  if (opts.cookie) headers['cookie'] = `sr_session=${opts.cookie}`;
  if (opts.bearer) headers['authorization'] = `Bearer ${opts.bearer}`;
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

const errorCode = async (res: Response): Promise<string> =>
  ErrorBody.parse(await res.json()).error.code;

const md = (slug: string, extra = '', body = 'You review code.') =>
  `---\nname: ${slug}\ndescription: Reviews diffs\n${extra}---\n${body}\n`;

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
  });
  session = /sr_session=([^;]+)/.exec(res.headers.get('set-cookie') ?? '')?.[1] ?? '';
  token = CreatedToken.parse(
    await (await authed('POST', '/api/tokens', { name: 'cli' })).json(),
  ).token;
  await authed('POST', '/api/folders', { slug: 'general', name: 'General', description: 'g' });
});

const createSkill = (slug: string) => {
  const form = new FormData();
  form.append('slug', slug);
  form.append('folder', 'general');
  form.append(
    'SKILL.md',
    new File([`---\nname: ${slug}\ndescription: d\n---\nBody.\n`], 'SKILL.md'),
  );
  return call('POST', '/api/skills', { cookie: session, form });
};

describe('/api/subagents', () => {
  it('runs the whole lifecycle with a session', async () => {
    const created = await authed('POST', '/api/subagents', {
      slug: 'reviewer',
      folder: 'general',
      content: md('reviewer', 'tools: [Read, Grep]\n'),
      message: 'first',
    });
    expect(created.status).toBe(201);
    expect(VersionRef.parse(await created.json())).toEqual({ slug: 'reviewer', version: 1 });

    const got = SubagentView.parse(await (await authed('GET', '/api/subagents/reviewer')).json());
    expect(got).toMatchObject({ slug: 'reviewer', tools: ['Read', 'Grep'], model: 'inherit' });
    expect(got.content).toContain('You review code.');

    const listed = SubagentSummary.array().parse(
      await (await authed('GET', '/api/subagents')).json(),
    );
    expect(listed.map((s) => s.slug)).toEqual(['reviewer']);

    const published = await authed('PUT', '/api/subagents/reviewer', {
      content: md('reviewer', 'tools: [Read]\n', 'Changed.'),
      baseVersion: 1,
    });
    expect(VersionRef.parse(await published.json()).version).toBe(2);
    const stale = await authed('PUT', '/api/subagents/reviewer', {
      content: md('reviewer'),
      baseVersion: 1,
    });
    expect(stale.status).toBe(409);
    expect(await errorCode(stale)).toBe('version_conflict');

    const history = SubagentVersionSummary.array().parse(
      await (await authed('GET', '/api/subagents/reviewer/history')).json(),
    );
    expect(history.map((v) => [v.number, v.authorLogin])).toEqual([
      [2, 'admin'],
      [1, 'admin'],
    ]);

    const diff = SubagentDiff.parse(
      await (await authed('GET', '/api/subagents/reviewer/diff?from=1&to=2')).json(),
    );
    expect(diff.tools).toEqual({ from: ['Read', 'Grep'], to: ['Read'] });
    expect(diff.patch).toContain('+Changed.');

    const rolled = await authed('POST', '/api/subagents/reviewer/rollback', {
      toVersion: 1,
      baseVersion: 2,
    });
    expect(VersionRef.parse(await rolled.json()).version).toBe(3);

    await authed('POST', '/api/folders', { slug: 'other', name: 'Other', description: 'o' });
    expect((await authed('POST', '/api/subagents/reviewer/move', { folder: 'other' })).status).toBe(
      204,
    );
    expect((await authed('POST', '/api/subagents/reviewer/archive')).status).toBe(204);
    const archived = await authed('PUT', '/api/subagents/reviewer', {
      content: md('reviewer'),
      baseVersion: 3,
    });
    expect(archived.status).toBe(409);
    expect(await errorCode(archived)).toBe('subagent_archived');
    expect((await authed('POST', '/api/subagents/reviewer/restore', {})).status).toBe(204);
    const after = SubagentView.parse(await (await authed('GET', '/api/subagents/reviewer')).json());
    expect(after).toMatchObject({ status: 'active', folder: { slug: 'other' }, version: 3 });
  });

  it('works with a Bearer token and no Origin', async () => {
    const headers = { bearer: token, origin: null } as const;
    const created = await call('POST', '/api/subagents', {
      ...headers,
      body: { slug: 'reviewer', folder: 'general', content: md('reviewer') },
    });
    expect(created.status).toBe(201);
    expect((await call('GET', '/api/subagents/reviewer', headers)).status).toBe(200);
    expect((await call('POST', '/api/subagents/reviewer/archive', { ...headers })).status).toBe(
      204,
    );
  });

  it('answers 403 csrf to a session mutation without Origin', async () => {
    const res = await call('POST', '/api/subagents', {
      cookie: session,
      origin: null,
      body: { slug: 'reviewer', folder: 'general', content: md('reviewer') },
    });
    expect(res.status).toBe(403);
    expect(await errorCode(res)).toBe('csrf');
  });

  it('maps the new error codes to statuses', async () => {
    const body = { slug: 'reviewer', folder: 'general', content: md('reviewer') };
    expect((await authed('POST', '/api/subagents', body)).status).toBe(201);

    const exists = await authed('POST', '/api/subagents', body);
    expect([exists.status, await errorCode(exists)]).toEqual([409, 'subagent_exists']);

    const missing = await authed('GET', '/api/subagents/nope');
    expect([missing.status, await errorCode(missing)]).toEqual([404, 'subagent_not_found']);

    const unknown = await authed('POST', '/api/subagents', {
      slug: 'other',
      folder: 'general',
      content: md('other', 'skills: [ghost]\n'),
    });
    expect([unknown.status, await errorCode(unknown)]).toEqual([422, 'unknown_skill']);

    const tooBig = await authed('POST', '/api/subagents', {
      ...body,
      slug: 'big',
      content: 'x'.repeat(65_537),
    });
    expect(tooBig.status).toBe(422);
  });

  it('shows usedBy on a skill and archivedSubagents on a folder archive', async () => {
    expect((await createSkill('code-review')).status).toBe(201);
    const created = await authed('POST', '/api/subagents', {
      slug: 'reviewer',
      folder: 'general',
      content: md('reviewer', 'skills: [code-review]\n'),
    });
    expect(created.status).toBe(201);

    const skill = SkillView.parse(await (await authed('GET', '/api/skills/code-review')).json());
    expect(skill.usedBy).toEqual(['reviewer']);

    const res = await authed('POST', '/api/folders/general/archive');
    expect(ArchiveFolderResponse.parse(await res.json())).toEqual({
      archivedSkills: 1,
      archivedSubagents: 1,
    });
  });
});
