import {
  CreatedToken,
  ErrorBody,
  FileDiff,
  SkillSummary,
  SkillView,
  TokenSummary,
  UserSummary,
  VersionSummary,
} from '@skills/contracts';
import type { Hono } from 'hono';
import { z } from 'zod';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vite-plus/test';
import { bootstrapAdmin } from '../../src/modules/identity/index.ts';
import { indexSkill } from '../../src/modules/search/index.ts';
import type { Config } from '../../src/platform/config.ts';
import { buildContainer, type Container } from '../../src/platform/container.ts';
import { createHttpApp } from '../../src/platform/http/app.ts';
import type { AppEnv } from '../../src/platform/http/env.ts';
import { createLogger } from '../../src/platform/logger.ts';
import { FakeEmbedder } from '../fakes/fake-embedder.ts';
import { startPg, truncateAll } from '../pg.ts';

const ORIGIN = 'http://skills.test';
const ADMIN_PW = 'admin-password-123';
const MEMBER_PW = 'member-password-123';

let pg: Awaited<ReturnType<typeof startPg>>;
let container: Container;
type App = Hono<AppEnv>;
let app: App;
let logLines: string[];
let remoteIp: string;

function configFor(overrides: Partial<Config> = {}): Config {
  return {
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
    ...overrides,
  };
}

function makeApp(overrides: Partial<Config> = {}, sql = pg.sql) {
  const logger = createLogger('info', { write: (line: string) => logLines.push(line) });
  const c = buildContainer(configFor(overrides), sql, { embedder: new FakeEmbedder(), logger });
  return { container: c, app: createHttpApp(c, { remoteAddress: () => remoteIp }).app };
}

beforeAll(async () => {
  pg = await startPg();
});
afterAll(async () => {
  await pg.stop();
});
beforeEach(async () => {
  await truncateAll(pg.sql);
  logLines = [];
  remoteIp = '10.0.0.1';
  ({ container, app } = makeApp());
  const boot = await bootstrapAdmin(container.identity, { login: 'admin', password: ADMIN_PW });
  if (!boot.ok) throw boot.error;
});

type Opts = {
  body?: unknown;
  form?: FormData;
  cookie?: string;
  origin?: string | null;
  headers?: Record<string, string>;
};

async function call(
  method: string,
  path: string,
  opts: Opts = {},
  target: App = app,
): Promise<Response> {
  const headers: Record<string, string> = { ...opts.headers };
  const origin = opts.origin === undefined ? ORIGIN : opts.origin;
  if (origin !== null) headers['origin'] = origin;
  if (opts.cookie) headers['cookie'] = `sr_session=${opts.cookie}`;
  let body: FormData | string | undefined;
  if (opts.form) body = opts.form;
  else if (opts.body !== undefined) {
    body = JSON.stringify(opts.body);
    headers['content-type'] = 'application/json';
  }
  return target.request(path, { method, headers, ...(body === undefined ? {} : { body }) });
}

async function loginAs(login: string, password: string, target: App = app): Promise<string> {
  const res = await call('POST', '/api/auth/login', { body: { login, password } }, target);
  expect(res.status).toBe(204);
  const m = /sr_session=([^;]+)/.exec(res.headers.get('set-cookie') ?? '');
  if (!m?.[1]) throw new Error('no session cookie');
  return m[1];
}

async function addMember(): Promise<void> {
  const admin = await loginAs('admin', ADMIN_PW);
  const res = await call('POST', '/api/users', {
    cookie: admin,
    body: { login: 'bob', password: MEMBER_PW, role: 'member' },
  });
  expect(res.status).toBe(201);
}

const skillMd = (slug: string, description: string, body = 'Body.') =>
  `---\nname: ${slug}\ndescription: ${description}\n---\n${body}\n`;

function skillForm(fields: Record<string, string>, files: Record<string, string | Uint8Array>) {
  const form = new FormData();
  for (const [k, v] of Object.entries(fields)) form.append(k, v);
  for (const [path, content] of Object.entries(files)) {
    form.append(
      path,
      new File(
        [typeof content === 'string' ? content : new Uint8Array(content)],
        path.split('/').at(-1) ?? path,
      ),
    );
  }
  return form;
}

async function json<S extends z.ZodType>(res: Response, schema: S): Promise<z.output<S>> {
  return schema.parse(await res.json());
}

async function errorCode(res: Response): Promise<string> {
  return (await json(res, ErrorBody)).error.code;
}

/** Runs `fn` n times strictly one after another. */
function times<T>(n: number, fn: (i: number) => Promise<T>): Promise<T[]> {
  return Array.from({ length: n }, (_, i) => i).reduce<Promise<T[]>>(async (prev, i) => {
    const acc = await prev;
    acc.push(await fn(i));
    return acc;
  }, Promise.resolve([]));
}

describe('auth', () => {
  it('requires a session for the API', async () => {
    const res = await app.request('/api/skills');
    expect(res.status).toBe(401);
    expect(await errorCode(res)).toBe('unauthenticated');
  });

  it('login sets a hardened session cookie; me and logout work', async () => {
    const res = await call('POST', '/api/auth/login', {
      body: { login: 'admin', password: ADMIN_PW },
    });
    expect(res.status).toBe(204);
    const cookie = res.headers.get('set-cookie') ?? '';
    expect(cookie).toMatch(/^sr_session=[A-Za-z0-9_-]{43};/);
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('SameSite=Strict');
    expect(cookie).toContain('Secure');
    expect(cookie).toContain('Path=/');
    const session = /sr_session=([^;]+)/.exec(cookie)?.[1] ?? '';

    const me = await call('GET', '/api/auth/me', { cookie: session });
    expect(await me.json()).toEqual({ login: 'admin', role: 'admin' });

    const out = await call('POST', '/api/auth/logout', { cookie: session });
    expect(out.status).toBe(204);
    expect(out.headers.get('set-cookie')).toMatch(/^sr_session=;.*Max-Age=0/);
    expect((await call('GET', '/api/auth/me', { cookie: session })).status).toBe(401);
  });

  it('omits Secure when cookieSecure is false', async () => {
    const plain = makeApp({ cookieSecure: false }).app;
    const res = await call(
      'POST',
      '/api/auth/login',
      { body: { login: 'admin', password: ADMIN_PW } },
      plain,
    );
    expect(res.headers.get('set-cookie')).not.toContain('Secure');
  });

  it('answers unknown user and wrong password identically', async () => {
    const a = await call('POST', '/api/auth/login', {
      body: { login: 'ghost', password: 'x'.repeat(12) },
    });
    const b = await call('POST', '/api/auth/login', {
      body: { login: 'admin', password: 'x'.repeat(12) },
    });
    expect(a.status).toBe(401);
    expect(b.status).toBe(401);
    expect(await a.text()).toBe(await b.text());
    expect(a.headers.get('set-cookie')).toBeNull();
  });

  it('locks a login after 5 failures with 429 and Retry-After', async () => {
    const responses = await times(6, () =>
      call('POST', '/api/auth/login', { body: { login: 'admin', password: 'wrong-password-x' } }),
    );
    expect(responses.map((r) => r.status)).toEqual([401, 401, 401, 401, 401, 429]);
    expect(Number(responses[5]?.headers.get('retry-after'))).toBeGreaterThan(0);
    expect(await errorCode(responses[5] ?? new Response('{}'))).toBe('locked');
  });

  it('ignores X-Forwarded-For unless trustProxy is set', async () => {
    const statuses = await times(21, async (i) => {
      const res = await call('POST', '/api/auth/login', {
        body: { login: `user${i}`, password: 'wrong-password-x' },
        headers: { 'x-forwarded-for': `192.0.2.${i}` },
      });
      return res.status;
    });
    // the per-IP limiter (20 failures) counts the real socket address
    expect(statuses.slice(0, 20).every((s) => s === 401)).toBe(true);
    expect(statuses[20]).toBe(429);
  });

  it('uses the proxy-appended (right-most) X-Forwarded-For hop when trustProxy is set', async () => {
    const proxied = makeApp({ trustProxy: true }).app;
    const statuses = await times(21, async (i) => {
      const res = await call(
        'POST',
        '/api/auth/login',
        {
          body: { login: `user${i}`, password: 'wrong-password-x' },
          headers: { 'x-forwarded-for': `6.6.6.6, 192.0.2.${i}` },
        },
        proxied,
      );
      return res.status;
    });
    expect(statuses.every((s) => s === 401)).toBe(true);
  });
});

describe('csrf', () => {
  it('rejects mutating /api requests without or with a foreign Origin', async () => {
    const session = await loginAs('admin', ADMIN_PW);
    const files = { 'SKILL.md': skillMd('pdf', 'PDF tools') };
    const none = await call('POST', '/api/skills', {
      cookie: session,
      form: skillForm({ slug: 'pdf', folder: 'general' }, files),
      origin: null,
    });
    expect(none.status).toBe(403);
    expect(await errorCode(none)).toBe('csrf');
    const foreign = await call('POST', '/api/skills', {
      cookie: session,
      form: skillForm({ slug: 'pdf', folder: 'general' }, files),
      origin: 'http://evil.test',
    });
    expect(foreign.status).toBe(403);
    expect(await errorCode(foreign)).toBe('csrf');
    const login = await call('POST', '/api/auth/login', {
      body: { login: 'admin', password: ADMIN_PW },
      origin: 'http://evil.test',
    });
    expect(login.status).toBe(403);
  });
});

describe('skills', () => {
  let session: string;
  beforeEach(async () => {
    session = await loginAs('admin', ADMIN_PW);
  });

  const create = (
    slug: string,
    description: string,
    extra: Record<string, string | Uint8Array> = {},
  ) =>
    call('POST', '/api/skills', {
      cookie: session,
      form: skillForm(
        { slug, folder: 'general', message: 'first' },
        { 'SKILL.md': skillMd(slug, description), ...extra },
      ),
    });

  const publishFromV1 = () =>
    call('PUT', '/api/skills/pdf', {
      cookie: session,
      form: skillForm({ baseVersion: '1' }, { 'SKILL.md': skillMd('pdf', 'again') }),
    });

  it('create → publish → history → diff → rollback → get', async () => {
    const created = await create('pdf', 'PDF tools', { 'scripts/run.sh': 'echo 1\n' });
    expect(created.status).toBe(201);
    expect(await created.json()).toEqual({ slug: 'pdf', version: 1 });

    const put = await call('PUT', '/api/skills/pdf', {
      cookie: session,
      form: skillForm(
        { baseVersion: '1', message: 'second' },
        { 'SKILL.md': skillMd('pdf', 'PDF tools v2'), 'scripts/run.sh': 'echo 2\n' },
      ),
    });
    expect(put.status).toBe(200);
    expect(await put.json()).toEqual({ slug: 'pdf', version: 2 });

    const history = await json(
      await call('GET', '/api/skills/pdf/history', { cookie: session }),
      z.array(VersionSummary),
    );
    expect(history.map((h) => h.number)).toEqual([2, 1]);
    expect(history[0]?.message).toBe('second');

    const diff = await json(
      await call('GET', '/api/skills/pdf/diff?from=1&to=2', { cookie: session }),
      z.array(FileDiff),
    );
    expect(diff.find((d) => d.path === 'scripts/run.sh')?.status).toBe('modified');

    const rb = await call('POST', '/api/skills/pdf/rollback', {
      cookie: session,
      body: { toVersion: 1, baseVersion: 2 },
    });
    expect(rb.status).toBe(200);
    expect(await rb.json()).toEqual({ slug: 'pdf', version: 3 });

    const view = await json(await call('GET', '/api/skills/pdf', { cookie: session }), SkillView);
    expect(view.version).toBe(3);
    expect(view.description).toBe('PDF tools');
    expect(view.files.map((f) => f.path)).toEqual(['scripts/run.sh']);

    const v2 = await json(
      await call('GET', '/api/skills/pdf?version=2', { cookie: session }),
      SkillView,
    );
    expect(v2.version).toBe(2);
  });

  it('PUT with a stale baseVersion → 409', async () => {
    await create('pdf', 'PDF tools');
    expect((await publishFromV1()).status).toBe(200);
    const stale = await publishFromV1();
    expect(stale.status).toBe(409);
    expect(await errorCode(stale)).toBe('version_conflict');
  });

  it('maps catalog errors to HTTP statuses', async () => {
    expect((await call('GET', '/api/skills/nope', { cookie: session })).status).toBe(404);
    expect((await create('pdf', 'PDF tools')).status).toBe(201);
    const dup = await create('pdf', 'PDF tools');
    expect(dup.status).toBe(409);
    expect(await errorCode(dup)).toBe('skill_exists');
    const mismatch = await call('POST', '/api/skills', {
      cookie: session,
      form: skillForm({ slug: 'other', folder: 'general' }, { 'SKILL.md': skillMd('pdf', 'x') }),
    });
    expect(mismatch.status).toBe(422);
    expect(await errorCode(mismatch)).toBe('name_mismatch');
    const missing = await call('POST', '/api/skills', {
      cookie: session,
      form: skillForm({ slug: 'empty', folder: 'general' }, { 'README.md': 'hi' }),
    });
    expect(missing.status).toBe(422);
    expect(await errorCode(missing)).toBe('missing_skill_md');
    const badQuery = await call('GET', '/api/skills/pdf?version=abc', { cookie: session });
    expect(badQuery.status).toBe(422);
    expect(await errorCode(badQuery)).toBe('invalid_request');
    expect((await call('GET', '/api/skills/pdf?version=9', { cookie: session })).status).toBe(404);
  });

  it('accepts skill uploads above 1 MiB and rejects them above the skill limit', async () => {
    const big = new Uint8Array(900_000).fill(97);
    const ok = await create('big', 'Big', { 'a.txt': big, 'b.txt': big });
    expect(ok.status).toBe(201);
    const files = Object.fromEntries(
      Array.from({ length: 12 }, (_, i) => [`f${i}.txt`, new Uint8Array(1_000_000).fill(98)]),
    );
    const tooBig = await create('huge', 'Huge', files);
    expect(tooBig.status).toBe(413);
    expect(await errorCode(tooBig)).toBe('limit_exceeded');
  });

  it('serves files with a content type; binaries as attachments', async () => {
    await create('pdf', 'PDF tools', {
      'notes.md': '# Notes',
      'page.html': '<script>alert(1)</script>',
      'img/logo.png': new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0, 1, 2, 3]),
    });
    const md = await call('GET', '/api/skills/pdf/files/notes.md', { cookie: session });
    expect(md.status).toBe(200);
    expect(md.headers.get('content-type')).toBe('text/markdown; charset=utf-8');
    expect(md.headers.get('content-disposition')).toBeNull();
    expect(await md.text()).toBe('# Notes');

    const html = await call('GET', '/api/skills/pdf/files/page.html', { cookie: session });
    expect(html.headers.get('content-type')).toBe('text/plain; charset=utf-8');

    const png = await call('GET', '/api/skills/pdf/files/img/logo.png', { cookie: session });
    expect(png.status).toBe(200);
    expect(png.headers.get('content-type')).toBe('application/octet-stream');
    expect(png.headers.get('content-disposition')).toBe("attachment; filename*=UTF-8''logo.png");
    expect(new Uint8Array(await png.arrayBuffer())).toEqual(
      new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0, 1, 2, 3]),
    );

    expect(
      (await call('GET', '/api/skills/pdf/files/missing.md', { cookie: session })).status,
    ).toBe(404);
    expect(
      (await call('GET', '/api/skills/pdf/files/..%2FSKILL.md', { cookie: session })).status,
    ).toBe(422);
  });

  it('lists by status, archives and restores, searches with q', async () => {
    await create('pdf', 'Extract text from PDF files');
    await create('borscht', 'Borscht recipe');
    await indexSkill(container.search, { slug: 'pdf' });
    await indexSkill(container.search, { slug: 'borscht' });

    const list = async (query: string) =>
      (
        await json(
          await call('GET', `/api/skills${query}`, { cookie: session }),
          z.array(SkillSummary),
        )
      ).map((s) => s.slug);
    expect((await list('')).toSorted()).toEqual(['borscht', 'pdf']);
    expect((await list('?q=pdf'))[0]).toBe('pdf');

    expect((await call('POST', '/api/skills/pdf/archive', { cookie: session })).status).toBe(204);
    expect(await list('')).toEqual(['borscht']);
    expect(await list('?status=archived')).toEqual(['pdf']);
    expect((await list('?status=all')).toSorted()).toEqual(['borscht', 'pdf']);
    // the search index still holds pdf until the outbox runs; status filtering hides it
    expect(await list('?q=pdf&status=active')).not.toContain('pdf');
    expect(await list('?q=pdf&status=archived')).toEqual(['pdf']);

    expect((await call('POST', '/api/skills/pdf/restore', { cookie: session })).status).toBe(204);
    expect((await list('')).toSorted()).toEqual(['borscht', 'pdf']);
  });

  it('PUT keeps unchanged files from the base version with the keep field', async () => {
    await create('pdf', 'PDF tools', { 'scripts/a.py': 'print(1)\n', 'drop.txt': 'x' });
    const keep = (value: string, base = '1') =>
      call('PUT', '/api/skills/pdf', {
        cookie: session,
        form: skillForm(
          { baseVersion: base, keep: value },
          { 'SKILL.md': skillMd('pdf', 'PDF tools v2') },
        ),
      });
    const put = await keep('["scripts/a.py"]');
    expect(put.status).toBe(200);
    expect(await put.json()).toEqual({ slug: 'pdf', version: 2 });
    const view = await json(await call('GET', '/api/skills/pdf', { cookie: session }), SkillView);
    expect(view.files.map((f) => f.path)).toEqual(['scripts/a.py']);
    const file = await call('GET', '/api/skills/pdf/files/scripts/a.py', { cookie: session });
    expect(await file.text()).toBe('print(1)\n');

    const missing = await keep('["nope.txt"]', '2');
    expect(missing.status).toBe(404);
    expect(await errorCode(missing)).toBe('file_not_found');
    const bad = await Promise.all(
      ['not json', '{"a":1}', JSON.stringify(Array(501).fill('a'))].map(async (value) => {
        const res = await keep(value, '2');
        return [res.status, await errorCode(res)];
      }),
    );
    expect(bad).toEqual(Array.from({ length: 3 }, () => [422, 'invalid_request']));
  });

  const createIn = (slug: string, folder: string | null) =>
    call('POST', '/api/skills', {
      cookie: session,
      form: skillForm(folder === null ? { slug } : { slug, folder }, {
        'SKILL.md': skillMd(slug, `${slug} tools`),
      }),
    });

  const rows = async (query: string) =>
    json(await call('GET', `/api/skills${query}`, { cookie: session }), z.array(SkillSummary));

  const folderApi = (method: string, path: string, body?: unknown) =>
    call(method, path, { cookie: session, ...(body === undefined ? {} : { body }) });

  describe('folders', () => {
    beforeEach(async () => {
      const r = await folderApi('POST', '/api/folders', {
        slug: 'devops',
        name: 'DevOps',
        description: 'CI',
      });
      expect(r.status).toBe(201);
    });

    it('create requires an existing active folder', async () => {
      expect((await createIn('a', null)).status).toBe(422);
      const unknown = await createIn('a', 'nope');
      expect(unknown.status).toBe(404);
      expect(await errorCode(unknown)).toBe('folder_not_found');
      await folderApi('POST', '/api/folders/devops/archive');
      const archived = await createIn('a', 'devops');
      expect(archived.status).toBe(409);
      expect(await errorCode(archived)).toBe('folder_archived');
    });

    it('filters the list by folder, with q too, and shows the folder', async () => {
      await createIn('deploy', 'devops');
      await createIn('pdf', 'general');
      await indexSkill(container.search, { slug: 'deploy' });
      await indexSkill(container.search, { slug: 'pdf' });
      const inDevops = await rows('?folder=devops');
      expect(inDevops.map((s) => s.slug)).toEqual(['deploy']);
      expect(inDevops[0]?.folder).toEqual({ slug: 'devops', name: 'DevOps' });
      expect((await rows('?folder=devops&q=deploy')).map((s) => s.slug)).toEqual(['deploy']);
      expect(await rows('?folder=devops&q=pdf')).toEqual([]);
      expect(await rows('?folder=nope')).toEqual([]);
    });

    it('applies the folder filter before the search limit', async () => {
      await times(55, async (i) => {
        // Stronger matches than the devops skill, so it falls outside the top 50 unfiltered.
        const slug = `general-${i}`;
        await call('POST', '/api/skills', {
          cookie: session,
          form: skillForm(
            { slug, folder: 'general' },
            { 'SKILL.md': skillMd(slug, 'tools tools tools tools') },
          ),
        });
        await indexSkill(container.search, { slug });
      });
      await createIn('devops-one', 'devops');
      await indexSkill(container.search, { slug: 'devops-one' });
      const hits = await rows('?folder=devops&q=tools');
      expect(hits.map((s) => s.slug)).toEqual(['devops-one']);
    });

    it('moves a skill without a new version', async () => {
      await createIn('pdf', 'general');
      const res = await folderApi('POST', '/api/skills/pdf/move', { folder: 'devops' });
      expect(res.status).toBe(204);
      const view = await json(await call('GET', '/api/skills/pdf', { cookie: session }), SkillView);
      expect(view.folder.slug).toBe('devops');
      expect(view.version).toBe(1);
      const bad = await folderApi('POST', '/api/skills/pdf/move', { folder: 'nope' });
      expect(bad.status).toBe(404);
      expect(await errorCode(bad)).toBe('folder_not_found');
    });

    it('restores a skill from an archived folder only into another folder', async () => {
      await createIn('deploy', 'devops');
      await folderApi('POST', '/api/folders/devops/archive');
      const plain = await call('POST', '/api/skills/deploy/restore', { cookie: session });
      expect(plain.status).toBe(409);
      expect(await errorCode(plain)).toBe('folder_archived');
      const into = await folderApi('POST', '/api/skills/deploy/restore', { folder: 'general' });
      expect(into.status).toBe(204);
      const view = await json(
        await call('GET', '/api/skills/deploy', { cookie: session }),
        SkillView,
      );
      expect([view.status, view.folder.slug]).toEqual(['active', 'general']);
    });
  });

  it('archiving moves updatedAt in the list', async () => {
    await create('pdf', 'PDF tools');
    const updatedAt = async () => {
      const all = await json(
        await call('GET', '/api/skills?status=all', { cookie: session }),
        z.array(SkillSummary),
      );
      return all[0]!.updatedAt;
    };
    const before = await updatedAt();
    await new Promise((r) => setTimeout(r, 5));
    expect((await call('POST', '/api/skills/pdf/archive', { cookie: session })).status).toBe(204);
    const after = await updatedAt();
    expect(Date.parse(after)).toBeGreaterThan(Date.parse(before));
  });

  it('history carries author logins; unknown authors are null', async () => {
    await create('pdf', 'PDF tools');
    expect((await publishFromV1()).status).toBe(200);
    await pg.sql`update catalog.skill_versions set author_id = gen_random_uuid() where number = 1`;
    const history = await json(
      await call('GET', '/api/skills/pdf/history', { cookie: session }),
      z.array(VersionSummary),
    );
    expect(history.map((h) => [h.number, h.authorLogin])).toEqual([
      [2, 'admin'],
      [1, null],
    ]);
  });
});

describe('tokens', () => {
  it('creates, lists and revokes tokens; the connect command carries /mcp and the token', async () => {
    const session = await loginAs('admin', ADMIN_PW);
    const res = await call('POST', '/api/tokens', { cookie: session, body: { name: 'laptop' } });
    expect(res.status).toBe(201);
    const created = await json(res, CreatedToken);
    expect(created.token).toMatch(/^sk_/);
    expect(created.connectCommand).toBe(
      `claude mcp add --transport http skills ${ORIGIN}/mcp --header "Authorization: Bearer ${created.token}"`,
    );

    const list = await json(
      await call('GET', '/api/tokens', { cookie: session }),
      z.array(TokenSummary),
    );
    expect(list.map((t) => t.id)).toEqual([created.id]);
    expect(JSON.stringify(list)).not.toContain(created.token);

    expect((await call('DELETE', `/api/tokens/${created.id}`, { cookie: session })).status).toBe(
      204,
    );
    const after = await json(
      await call('GET', '/api/tokens', { cookie: session }),
      z.array(TokenSummary),
    );
    expect(after[0]?.revokedAt).not.toBeNull();
    expect((await call('DELETE', '/api/tokens/not-a-uuid', { cookie: session })).status).toBe(404);
  });
});

describe('users', () => {
  it('admin-only: member gets 403, admin manages users', async () => {
    await addMember();
    const member = await loginAs('bob', MEMBER_PW);
    const denied = await call('GET', '/api/users', { cookie: member });
    expect(denied.status).toBe(403);
    expect(await errorCode(denied)).toBe('forbidden');
    expect(
      (
        await call('POST', '/api/users', {
          cookie: member,
          body: { login: 'eve', password: 'p'.repeat(12) },
        })
      ).status,
    ).toBe(403);

    const admin = await loginAs('admin', ADMIN_PW);
    const created = await call('POST', '/api/users', {
      cookie: admin,
      body: { login: 'carol', password: 'carol-password-1', role: 'member' },
    });
    expect(created.status).toBe(201);
    const { id } = await json(created, z.object({ id: z.uuid() }));
    const weak = await call('POST', '/api/users', {
      cookie: admin,
      body: { login: 'dave', password: 'short' },
    });
    expect(weak.status).toBe(422);
    expect(await errorCode(weak)).toBe('weak_password');

    const users = await json(
      await call('GET', '/api/users', { cookie: admin }),
      z.array(UserSummary),
    );
    expect(users.map((u) => u.login).toSorted()).toEqual(['admin', 'bob', 'carol']);

    expect(
      (
        await call('POST', `/api/users/${id}/password`, {
          cookie: admin,
          body: { password: 'new-password-123' },
        })
      ).status,
    ).toBe(204);
    await loginAs('carol', 'new-password-123');
    expect(
      (await call('POST', `/api/users/${id}/disable`, { cookie: admin, body: {} })).status,
    ).toBe(204);
    const disabled = await call('POST', '/api/auth/login', {
      body: { login: 'carol', password: 'new-password-123' },
    });
    expect(disabled.status).toBe(401);
  });
});

describe('logging', () => {
  it('log lines never contain passwords, tokens or session ids', async () => {
    const session = await loginAs('admin', ADMIN_PW);
    await call('POST', '/api/auth/login', {
      body: { login: 'admin', password: 'wrong-secret-pw' },
    });
    const res = await call('POST', '/api/tokens', { cookie: session, body: { name: 'ci' } });
    const { token } = await json(res, CreatedToken);
    await call('GET', '/api/auth/me', {
      cookie: session,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(logLines.length).toBeGreaterThan(0);
    const all = logLines.join('\n');
    for (const secret of [ADMIN_PW, 'wrong-secret-pw', token, session]) {
      expect(all).not.toContain(secret);
    }
  });
});
