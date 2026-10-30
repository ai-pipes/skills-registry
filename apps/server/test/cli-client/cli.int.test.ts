import { lstatSync, readdirSync, readFileSync, readlinkSync } from 'node:fs';
import { join } from 'node:path';
import { CreatedToken, SkillView } from '@skills/contracts';
import type { Hono } from 'hono';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vite-plus/test';
import { runCli } from '../../../../packages/cli/src/cli.ts';
import { fakeEnv } from '../../../../packages/cli/test/fake-env.ts';
import { type FakeRepo, fakeGithub, tarball } from '../../../../packages/cli/test/tarball.ts';
import { bootstrapAdmin } from '../../src/modules/identity/index.ts';
import type { Config } from '../../src/platform/config.ts';
import { buildContainer } from '../../src/platform/container.ts';
import { createHttpApp } from '../../src/platform/http/app.ts';
import type { AppEnv } from '../../src/platform/http/env.ts';
import { createLogger } from '../../src/platform/logger.ts';
import { FakeEmbedder } from '../fakes/fake-embedder.ts';
import { startPg, truncateAll } from '../pg.ts';

const ORIGIN = 'http://skills.test';
const GH = 'http://gh.test';
const ADMIN_PW = 'admin-password-123';
const C1 = '1111111aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const C2 = '2222222bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const MD = (body: string) => `---\nname: demo\ndescription: Demo skill\n---\n${body}\n`;

/** The fake repository's tarball at one commit. */
const repoTarball = (skillMd: string, run: string) =>
  tarball([
    { path: 'skills/demo/SKILL.md', content: skillMd },
    { path: 'skills/demo/reference/a.md', content: 'reference\n' },
    { path: 'skills/demo/scripts/run.sh', content: run },
    { path: 'README.md', content: 'repo readme\n' },
  ]);

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

/** A browser-like request (session cookie + Origin), as the web UI sends it. */
async function ui(method: string, path: string, body?: FormData | object): Promise<Response> {
  const headers: Record<string, string> = { origin: ORIGIN, cookie: `sr_session=${session}` };
  let payload: FormData | string | undefined;
  if (body instanceof FormData) payload = body;
  else if (body !== undefined) {
    payload = JSON.stringify(body);
    headers['content-type'] = 'application/json';
  }
  return app.request(path, {
    method,
    headers,
    ...(payload === undefined ? {} : { body: payload }),
  });
}

const view = async () => SkillView.parse(await (await ui('GET', '/api/skills/demo')).json());

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
  session = /sr_session=([^;]+)/.exec(res.headers.get('set-cookie') ?? '')?.[1] ?? '';
});

describe('client CLI against the real server and a fake GitHub', () => {
  it('login → import → edit in UI → update (dry run, real) → install → uninstall', async () => {
    const { token } = CreatedToken.parse(
      await (await ui('POST', '/api/tokens', { name: 'cli' })).json(),
    );
    const repo: FakeRepo = {
      defaultBranch: 'main',
      refs: { main: C1 },
      tarballs: { [C1]: repoTarball(MD('First.'), 'echo 1\n') },
    };
    const github = fakeGithub({ 'acme/skills': repo }, { apiUrl: GH });
    const fetchFn: typeof fetch = async (input, init) => {
      const req = new Request(input, init);
      if (req.url.startsWith(`${ORIGIN}/`)) {
        return app.request(req.url.slice(ORIGIN.length), {
          method: req.method,
          headers: req.headers,
          ...(req.body === null ? {} : { body: await req.arrayBuffer() }),
        });
      }
      return github.fetch(req);
    };
    const env = fakeEnv({
      fetch: fetchFn,
      readSecret: () => Promise.resolve(token),
      vars: { GITHUB_API_URL: GH },
    });
    const run = async (...argv: string[]) => {
      env.stdout.length = 0;
      env.stderr.length = 0;
      return runCli(argv, env);
    };

    expect(await run('login', ORIGIN)).toBe(0);
    expect(env.stdout.join('\n')).toContain('as admin');
    expect(env.stdout.join('\n')).not.toContain(token);

    expect(await run('import', 'acme/skills', '--skill', 'demo'), env.stderr.join('\n')).toBe(0);
    const folders = await (await ui('GET', '/api/folders')).json();
    expect(JSON.stringify(folders)).toContain('"slug":"demo"');
    let v = await view();
    expect(v.version).toBe(1);
    expect(v.source).toEqual({
      host: 'github.com',
      repo: 'acme/skills',
      path: 'skills/demo',
      ref: null,
      syncedVersion: 1,
    });
    expect(v.sourceCommit).toBe(C1);
    // SKILL.md is shown separately from the other files.
    expect(v.files.map((f) => f.path).toSorted()).toEqual(['reference/a.md', 'scripts/run.sh']);

    // An edit in the UI: no sourceCommit, the source stays as it was.
    const form = new FormData();
    form.append('baseVersion', '1');
    form.append('message', 'local tweak');
    form.append('SKILL.md', new File([MD('Edited locally.')], 'SKILL.md'));
    form.append('reference/a.md', new File(['reference\n'], 'a.md'));
    form.append('scripts/run.sh', new File(['echo 1\n'], 'run.sh'));
    expect((await ui('PUT', '/api/skills/demo', form)).status).toBe(200);
    v = await view();
    expect([v.version, v.source?.syncedVersion, v.sourceCommit]).toEqual([2, 1, null]);

    // Upstream is still at the synced commit: the registry edit is kept, nothing is published.
    expect(await run('update', 'demo'), env.stderr.join('\n')).toBe(0);
    expect(env.stdout).toEqual([
      'demo is up to date (acme/skills/skills/demo@1111111)',
      '  registry changes since v1 are kept (v2)',
    ]);
    expect((await view()).version).toBe(2);

    // Upstream moves to a second commit.
    repo.refs.main = C2;
    repo.tarballs[C2] = repoTarball(MD('Second.'), 'echo 2\n');

    expect(await run('update', 'demo', '--dry-run'), env.stderr.join('\n')).toBe(0);
    expect(env.stderr.join('\n')).toContain('SKILL.md');
    expect((await view()).version).toBe(2);

    expect(await run('update', 'demo'), env.stderr.join('\n')).toBe(0);
    expect(env.stderr.join('\n')).toContain('SKILL.md');
    expect(env.stdout.join('\n')).toContain('v2 → v3 from acme/skills/skills/demo@2222222');
    v = await view();
    expect([v.version, v.source?.syncedVersion, v.sourceCommit]).toEqual([3, 3, C2]);

    expect(await run('install', 'demo', '-a', 'claude-code'), env.stderr.join('\n')).toBe(0);
    const canonical = join(env.cwd, '.agents/skills/demo');
    expect(readFileSync(join(canonical, 'SKILL.md'), 'utf8')).toBe(MD('Second.'));
    expect(readFileSync(join(canonical, 'scripts/run.sh'), 'utf8')).toBe('echo 2\n');
    const link = join(env.cwd, '.claude/skills/demo');
    expect(lstatSync(link).isSymbolicLink()).toBe(true);
    expect(readFileSync(join(link, 'reference/a.md'), 'utf8')).toBe('reference\n');
    expect(readlinkSync(link)).toContain('.agents/skills/demo');

    expect(await run('uninstall', 'demo', '-a', 'claude-code'), env.stderr.join('\n')).toBe(0);
    expect(readdirSync(join(env.cwd, '.claude/skills'))).toEqual([]);
    expect(readdirSync(join(env.cwd, '.agents/skills'))).toEqual([]);
  });
});
