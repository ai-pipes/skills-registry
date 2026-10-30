import { ErrorBody } from '@skills/contracts';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vite-plus/test';
import { bootstrapAdmin } from '../../src/modules/identity/index.ts';
import type { Config } from '../../src/platform/config.ts';
import { buildContainer, type Container } from '../../src/platform/container.ts';
import { createDb } from '../../src/platform/db.ts';
import { createHttpApp } from '../../src/platform/http/app.ts';
import type { AppEnv } from '../../src/platform/http/env.ts';
import { createLogger } from '../../src/platform/logger.ts';
import { FakeEmbedder } from '../fakes/fake-embedder.ts';
import { startPg, truncateAll } from '../pg.ts';

const ORIGIN = 'http://skills.test';
const ADMIN_PW = 'admin-password-123';
// ADR 0006: the strict Part 1 policy; the UI inserts no <style>, so no style-src-elem.
const CSP =
  "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; " +
  "frame-ancestors 'none'";

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

function makeApp(overrides: Partial<Config> = {}, sql = pg.sql, webRoot?: string) {
  const logger = createLogger('info', { write: (line: string) => logLines.push(line) });
  const c = buildContainer(configFor(overrides), sql, { embedder: new FakeEmbedder(), logger });
  return {
    container: c,
    app: createHttpApp(c, { remoteAddress: () => remoteIp, ...(webRoot ? { webRoot } : {}) }).app,
  };
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

type Opts = { body?: unknown; cookie?: string; origin?: string | null };

async function call(
  method: string,
  path: string,
  opts: Opts = {},
  target: App = app,
): Promise<Response> {
  const headers: Record<string, string> = {};
  const origin = opts.origin === undefined ? ORIGIN : opts.origin;
  if (origin !== null) headers['origin'] = origin;
  if (opts.cookie) headers['cookie'] = `sr_session=${opts.cookie}`;
  let body: string | undefined;
  if (opts.body !== undefined) {
    body = JSON.stringify(opts.body);
    headers['content-type'] = 'application/json';
  }
  return target.request(path, { method, headers, ...(body === undefined ? {} : { body }) });
}

async function loginAs(login: string, password: string): Promise<string> {
  const res = await call('POST', '/api/auth/login', { body: { login, password } });
  expect(res.status).toBe(204);
  const m = /sr_session=([^;]+)/.exec(res.headers.get('set-cookie') ?? '');
  if (!m?.[1]) throw new Error('no session cookie');
  return m[1];
}

async function errorCode(res: Response): Promise<string> {
  return ErrorBody.parse(await res.json()).error.code;
}

describe('platform', () => {
  it('/healthz answers ok', async () => {
    const res = await app.request('/healthz');
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('ok');
  });

  it('/healthz answers 503 fail without details when the database is down', async () => {
    const broken = createDb('postgres://nobody:x@127.0.0.1:1/none');
    try {
      const res = await makeApp({}, broken).app.request('/healthz');
      expect(res.status).toBe(503);
      expect(await res.text()).toBe('fail');
    } finally {
      await broken.end({ timeout: 0 });
    }
  });

  it('/healthz answers 503 fail within 2 s when the database hangs', async () => {
    const hung = Object.assign(() => new Promise<never>(() => {}), pg.sql);
    const started = performance.now();
    const res = await makeApp({}, hung).app.request('/healthz');
    expect(res.status).toBe(503);
    expect(await res.text()).toBe('fail');
    expect(performance.now() - started).toBeLessThan(2000);
  });

  it('a thrown HTTPException keeps its own response', async () => {
    app.get('/__teapot', () => {
      throw new HTTPException(418, { res: new Response('teapot', { status: 418 }) });
    });
    const res = await app.request('/__teapot');
    expect(res.status).toBe(418);
    expect(await res.text()).toBe('teapot');
  });

  it('sets security headers on every response', async () => {
    const res = await app.request('/api/skills');
    expect(res.headers.get('content-security-policy')).toBe(CSP);
    expect(res.headers.get('referrer-policy')).toBe('no-referrer');
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(res.headers.get('x-request-id')).toBeTruthy();
  });

  it('unknown errors become a bare 500 and are logged with the request id', async () => {
    const broken = createDb('postgres://nobody:x@127.0.0.1:1/none');
    try {
      const res = await call(
        'GET',
        '/api/auth/me',
        { cookie: 'a'.repeat(43) },
        makeApp({}, broken).app,
      );
      expect(res.status).toBe(500);
      expect(await res.json()).toEqual({ error: { code: 'internal', message: 'Internal error' } });
      const id = res.headers.get('x-request-id');
      expect(id).toBeTruthy();
      expect(logLines.some((l) => l.includes('"level":50') && l.includes(id ?? '?'))).toBe(true);
    } finally {
      await broken.end({ timeout: 0 });
    }
  });

  it('logs an unknown error by name and request id, never its message', async () => {
    app.get('/__boom', () => {
      throw new TypeError('secret-detail-xyz');
    });
    const res = await app.request('/__boom');
    expect(res.status).toBe(500);
    const id = res.headers.get('x-request-id') ?? '?';
    const line = logLines.find((l) => l.includes('"level":50')) ?? '';
    expect(line).toContain('TypeError');
    expect(line).toContain(id);
    expect(logLines.join('\n')).not.toContain('secret-detail-xyz');
  });

  it('rejects bodies over 1 MiB on ordinary routes with 413', async () => {
    const res = await call('POST', '/api/auth/login', {
      body: { login: 'admin', password: 'x'.repeat(1_100_000) },
    });
    expect(res.status).toBe(413);
    expect(await errorCode(res)).toBe('limit_exceeded');
  });

  it('upload routes check the session before reading a large body', async () => {
    const form = new FormData();
    form.append('SKILL.md', new File([new Uint8Array(2_000_000)], 'SKILL.md'));
    const res = await app.request('/api/skills', {
      method: 'POST',
      headers: { origin: ORIGIN },
      body: form,
    });
    expect(res.status).toBe(401);
  });

  it('serves 404 for unknown paths when the UI is not built', async () => {
    expect((await app.request('/some/page')).status).toBe(404);
    expect((await app.request('/api/nope')).status).toBe(401);
    const session = await loginAs('admin', ADMIN_PW);
    const res = await call('GET', '/api/nope', { cookie: session });
    expect(res.status).toBe(404);
    expect(await errorCode(res)).toBe('not_found');
  });
});

describe('logout', () => {
  it('is stateless: a missing or unknown session cookie still gets 204 and a cleared cookie', async () => {
    const responses = await Promise.all(
      [undefined, 'z'.repeat(43)].map((cookie) =>
        call('POST', '/api/auth/logout', cookie ? { cookie } : {}),
      ),
    );
    for (const res of responses) {
      expect(res.status).toBe(204);
      const set = res.headers.get('set-cookie') ?? '';
      expect(set).toContain('sr_session=;');
      expect(set).toContain('Max-Age=0');
    }
  });

  it('still requires Origin', async () => {
    const res = await call('POST', '/api/auth/logout', { origin: null });
    expect(res.status).toBe(403);
    expect(await errorCode(res)).toBe('csrf');
  });

  it('ends a live session', async () => {
    const session = await loginAs('admin', ADMIN_PW);
    expect((await call('POST', '/api/auth/logout', { cookie: session })).status).toBe(204);
    expect((await call('GET', '/api/auth/me', { cookie: session })).status).toBe(401);
  });
});

describe('web UI', () => {
  let root: string;
  let ui: App;
  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), 'web-'));
    await mkdir(join(root, 'assets'));
    await writeFile(join(root, 'index.html'), '<!doctype html><title>ui</title>');
    await writeFile(join(root, 'assets', 'a.js'), 'console.log(1)');
  });
  afterAll(async () => {
    await rm(root, { recursive: true });
  });
  beforeEach(() => {
    ui = makeApp({}, pg.sql, root).app;
  });
  const html = { headers: { accept: 'text/html,application/xhtml+xml' } };

  it('serves static files with the security headers', async () => {
    const res = await ui.request('/index.html');
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('<title>ui</title>');
    expect(res.headers.get('content-security-policy')).toBe(CSP);
  });

  it('serves index.html for client routes requested as HTML', async () => {
    const res = await ui.request('/skills/code-review', html);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('<title>ui</title>');
    expect(res.headers.get('cache-control')).toBe('no-cache');
    expect((await ui.request('/skills/code-review')).status).toBe(404);
  });

  it('serves /assets/* with an immutable cache', async () => {
    const res = await ui.request('/assets/a.js');
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('public, max-age=31536000, immutable');
  });

  it('does not turn missing files into index.html', async () => {
    expect((await ui.request('/missing.png', html)).status).toBe(404);
    expect((await ui.request('/missing.js')).status).toBe(404);
  });

  it('leaves /api, /mcp and /healthz alone', async () => {
    expect((await ui.request('/api/nope', html)).status).toBe(401);
    const session = await loginAs('admin', ADMIN_PW);
    const res = await call('GET', '/api/nope', { cookie: session }, ui);
    expect(res.status).toBe(404);
    expect(await errorCode(res)).toBe('not_found');
    expect(await (await ui.request('/healthz', html)).text()).toBe('ok');
    expect((await ui.request('/mcp', html)).headers.get('content-type')).not.toContain('text/html');
  });
});
