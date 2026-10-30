import { CreatedToken, ErrorBody } from '@skills/contracts';
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
let tokenId: string;
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

async function errorCode(res: Response): Promise<string> {
  return ErrorBody.parse(await res.json()).error.code;
}

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
  const created = CreatedToken.parse(
    await (await call('POST', '/api/tokens', { cookie: session, body: { name: 'cli' } })).json(),
  );
  tokenId = created.id;
  token = created.token;
});

describe('Bearer tokens on /api (ADR 0008)', () => {
  it('reads with a token and no cookie', async () => {
    const res = await call('GET', '/api/skills', { bearer: token, origin: null });
    expect(res.status).toBe(200);
  });

  it('mutates with a token and no Origin; a cookie without Origin is still csrf', async () => {
    const withToken = await call('POST', '/api/folders', {
      bearer: token,
      origin: null,
      body: { slug: 'devops', name: 'DevOps', description: 'CI' },
    });
    expect(withToken.status).toBe(201);

    const withCookie = await call('POST', '/api/folders', {
      cookie: session,
      origin: null,
      body: { slug: 'other', name: 'Other', description: 'x' },
    });
    expect(withCookie.status).toBe(403);
    expect(await errorCode(withCookie)).toBe('csrf');
  });

  it('rejects a cookie together with a token', async () => {
    const res = await call('GET', '/api/skills', { cookie: session, bearer: token });
    expect(res.status).toBe(400);
    expect(await errorCode(res)).toBe('invalid_request');
  });

  it('keeps tokens and users out of reach of a token', async () => {
    const paths = ['/api/tokens', '/api/users', `/api/tokens/${tokenId}`];
    const codes = await Promise.all(
      paths.map(async (path) => {
        const res = await call('GET', path, { bearer: token, origin: null });
        return `${res.status} ${await errorCode(res)}`;
      }),
    );
    expect(codes).toEqual(paths.map(() => '403 forbidden'));
    const create = await call('POST', '/api/tokens', {
      bearer: token,
      origin: null,
      body: { name: 'evil' },
    });
    expect(create.status).toBe(403);
    expect(await pg.sql`select 1 from identity.api_tokens`).toHaveLength(1);
  });

  it('answers 401 with WWW-Authenticate for a revoked or malformed token', async () => {
    expect((await call('DELETE', `/api/tokens/${tokenId}`, { cookie: session })).status).toBe(204);
    const revoked = await call('POST', '/api/folders', {
      bearer: token,
      origin: null,
      body: { slug: 'devops', name: 'DevOps', description: 'CI' },
    });
    expect(revoked.status).toBe(401);
    expect(revoked.headers.get('www-authenticate')).toBe('Bearer');
    expect(await pg.sql`select 1 from catalog.folders where slug = 'devops'`).toHaveLength(0);

    const malformed = await app.request('/api/skills', { headers: { authorization: 'Basic x' } });
    expect(malformed.status).toBe(401);
    expect(malformed.headers.get('www-authenticate')).toBe('Bearer');
  });

  it('reports the token owner on /api/auth/me', async () => {
    const res = await call('GET', '/api/auth/me', { bearer: token, origin: null });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ login: 'admin', role: 'admin' });
  });

  it('audits a skill created with a token under the token owner', async () => {
    const form = new FormData();
    form.append('slug', 'pdf');
    form.append('folder', 'general');
    form.append(
      'SKILL.md',
      new File(['---\nname: pdf\ndescription: PDF tools\n---\nBody.\n'], 'SKILL.md'),
    );
    const res = await call('POST', '/api/skills', { bearer: token, origin: null, form });
    expect(res.status).toBe(201);
    const [owner] = await pg.sql<
      { id: string }[]
    >`select id from identity.users where login = 'admin'`;
    const rows = await pg.sql<{ actor_id: string }[]>`
      select actor_id from platform.audit_log where action = 'skill.create'`;
    expect(rows.map((r) => r.actor_id)).toEqual([owner?.id]);
  });
});
