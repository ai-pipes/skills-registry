import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vite-plus/test';
import { createSkill } from '../src/modules/catalog/index.ts';
import { actAs, authenticateToken, bootstrapAdmin, login } from '../src/modules/identity/index.ts';
import { runCli } from '../src/platform/cli-commands.ts';
import type { Config } from '../src/platform/config.ts';
import { buildContainer, type Container } from '../src/platform/container.ts';
import { createLogger } from '../src/platform/logger.ts';
import { FakeEmbedder } from './fakes/fake-embedder.ts';
import { startPg, truncateAll } from './pg.ts';

const ADMIN_PW = 'admin-password-123';

let pg: Awaited<ReturnType<typeof startPg>>;
let container: Container;

const config: Config = {
  port: 3000,
  databaseUrl: 'postgres://unused',
  publicUrl: 'https://skills.example.com/',
  allowedHosts: [],
  trustProxy: false,
  trustProxyHops: 1,
  cookieSecure: true,
  sessionSecret: 's'.repeat(32),
  embedder: 'local',
  modelDir: '/nonexistent',
  searchMinSimilarity: 0.3,
  logLevel: 'silent',
};

const skillMd = (name: string, description: string) =>
  `---\nname: ${name}\ndescription: ${description}\n---\n\n# ${name}\n`;

async function seedSkills(): Promise<void> {
  const admin = await actAs(container.identity, 'admin');
  if (!admin.ok) throw admin.error;
  const skills = [
    ['code-review', 'Review code changes'],
    ['pdf-tools', 'Work with PDF files'],
  ] as const;
  const results = await Promise.all(
    skills.map(([slug, description]) =>
      createSkill(container.catalog, {
        slug,
        folder: 'general',
        files: [{ path: 'SKILL.md', bytes: new TextEncoder().encode(skillMd(slug, description)) }],
        actorId: admin.value.userId,
        message: null,
        source: null,
        sourceCommit: null,
      }),
    ),
  );
  for (const r of results) if (!r.ok) throw r.error;
}

async function cli(argv: string[], stdin = '') {
  const out: string[] = [];
  const err: string[] = [];
  const code = await runCli(argv, container, {
    readStdin: async () => stdin,
    out: (line) => out.push(line),
    err: (line) => err.push(line),
  });
  return { code, out, err };
}

beforeAll(async () => {
  pg = await startPg();
});
afterAll(async () => {
  await pg.stop();
});

beforeEach(async () => {
  await truncateAll(pg.sql);
  container = buildContainer(config, pg.sql, {
    embedder: new FakeEmbedder(),
    logger: createLogger('silent'),
  });
  const boot = await bootstrapAdmin(container.identity, { login: 'admin', password: ADMIN_PW });
  if (!boot.ok) throw boot.error;
});

describe('cli users and tokens', () => {
  it('create-token prints an sk_ token and the claude mcp add command; the token works', async () => {
    const r = await cli(['create-token', 'admin', '--name', 'laptop']);
    expect(r.code).toBe(0);
    const [token, command] = r.out;
    expect(token).toMatch(/^sk_[A-Za-z0-9_-]{43}$/);
    expect(command).toBe(
      `claude mcp add --transport http skills https://skills.example.com/mcp --header "Authorization: Bearer ${token}"`,
    );
    const auth = await authenticateToken(container.identity, { token: token ?? '', ip: 'x' });
    expect(auth).toMatchObject({ ok: true, value: { login: 'admin' } });
  });

  it('create-token audits the token with via=cli', async () => {
    await cli(['create-token', 'admin', '--name', 'laptop']);
    const rows = await pg.sql<
      { meta: Record<string, unknown> }[]
    >`select meta from platform.audit_log where action = 'token.create'`;
    expect(rows[0]?.meta).toMatchObject({ via: 'cli', name: 'laptop' });
  });

  it('create-user reads the password from stdin and the user can log in', async () => {
    const r = await cli(['create-user', 'bob', '--role', 'member'], 'bob-password-123\n');
    expect(r.code).toBe(0);
    const session = await login(container.identity, {
      login: 'bob',
      password: 'bob-password-123',
      ip: 'x',
    });
    expect(session.ok).toBe(true);
    const dup = await cli(['create-user', 'bob', '--role', 'member'], 'bob-password-123\n');
    expect(dup.code).toBe(1);
    expect(dup.err.join('\n')).toContain('user_exists');
    const role = await cli(['create-user', 'eve', '--role', 'root'], 'eve-password-123\n');
    expect(role.code).toBe(2);
  });

  it('reindex reports the number of indexed skills', async () => {
    await seedSkills();
    const r = await cli(['reindex']);
    expect(r.code).toBe(0);
    expect(r.out).toEqual(['reindexed 2 skills']);
  });

  it('prints usage for an unknown command or missing arguments', async () => {
    const r = await cli(['frobnicate']);
    expect(r.code).toBe(2);
    expect(r.err.join('\n')).toContain('Usage');
    expect((await cli(['create-token', 'admin'])).code).toBe(2);
    expect((await cli(['reindex', 'extra'])).code).toBe(2);
  });
});
