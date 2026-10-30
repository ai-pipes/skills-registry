import { CreatedToken } from '@skills/contracts';
import { type ServerType, serve } from '@hono/node-server';
import { Client, SdkHttpError, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vite-plus/test';
import { z } from 'zod';
import { bootstrapAdmin } from '../../src/modules/identity/index.ts';
import { indexSkill } from '../../src/modules/search/index.ts';
import type { Config } from '../../src/platform/config.ts';
import { buildContainer, type Container } from '../../src/platform/container.ts';
import { createHttpApp } from '../../src/platform/http/app.ts';
import { createLogger } from '../../src/platform/logger.ts';
import { SERVER_INSTRUCTIONS } from '../../src/platform/mcp/instructions.ts';
import { FakeEmbedder } from '../fakes/fake-embedder.ts';
import { startPg, truncateAll } from '../pg.ts';

const PUBLIC_ORIGIN = 'http://skills.test';
const ADMIN_PW = 'admin-password-123';
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);

let pg: Awaited<ReturnType<typeof startPg>>;
let container: Container;
let server: ServerType;
let baseUrl: string;
let logLines: string[];
let clients: Client[];

function config(): Config {
  return {
    port: 0,
    databaseUrl: 'postgres://unused',
    publicUrl: `${PUBLIC_ORIGIN}/`,
    allowedHosts: [],
    trustProxy: false,
    trustProxyHops: 1,
    cookieSecure: false,
    sessionSecret: 's'.repeat(32),
    embedder: 'local',
    modelDir: '/nonexistent',
    searchMinSimilarity: 0.3,
    logLevel: 'info',
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
  clients = [];
  const logger = createLogger('info', { write: (line: string) => logLines.push(line) });
  container = buildContainer(config(), pg.sql, { embedder: new FakeEmbedder(), logger });
  const { app } = createHttpApp(container);
  await new Promise<void>((resolve) => {
    server = serve({ fetch: app.fetch, port: 0, hostname: '127.0.0.1' }, () => resolve());
  });
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('no TCP address');
  baseUrl = `http://127.0.0.1:${address.port}`;
  const boot = await bootstrapAdmin(container.identity, { login: 'admin', password: ADMIN_PW });
  if (!boot.ok) throw boot.error;
});

afterEach(async () => {
  await Promise.all(clients.map((c) => c.close()));
  await new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())));
});

/** REST call through the real server, as the web UI does it. */
async function rest(
  method: string,
  path: string,
  init: { cookie?: string; body?: unknown; form?: FormData } = {},
): Promise<Response> {
  const headers: Record<string, string> = { origin: PUBLIC_ORIGIN };
  if (init.cookie) headers['cookie'] = `sr_session=${init.cookie}`;
  let body: string | FormData | undefined;
  if (init.form) body = init.form;
  else if (init.body !== undefined) {
    body = JSON.stringify(init.body);
    headers['content-type'] = 'application/json';
  }
  return fetch(`${baseUrl}${path}`, { method, headers, ...(body === undefined ? {} : { body }) });
}

async function login(): Promise<string> {
  const res = await rest('POST', '/api/auth/login', {
    body: { login: 'admin', password: ADMIN_PW },
  });
  expect(res.status).toBe(204);
  const m = /sr_session=([^;]+)/.exec(res.headers.get('set-cookie') ?? '');
  if (!m?.[1]) throw new Error('no session cookie');
  return m[1];
}

async function newToken(session: string): Promise<{ id: string; token: string }> {
  const res = await rest('POST', '/api/tokens', { cookie: session, body: { name: 'cli' } });
  expect(res.status).toBe(201);
  return CreatedToken.parse(await res.json());
}

const skillMd = (slug: string, description: string, body = 'Body.') =>
  `---\nname: ${slug}\ndescription: ${description}\n---\n${body}\n`;

function form(fields: Record<string, string>, files: Record<string, string | Uint8Array>) {
  const f = new FormData();
  for (const [k, v] of Object.entries(fields)) f.append(k, v);
  for (const [path, content] of Object.entries(files)) {
    const part = typeof content === 'string' ? content : new Uint8Array(content);
    f.append(path, new File([part], path.split('/').at(-1) ?? path));
  }
  return f;
}

// Russian descriptions and queries are deliberate: search must work across languages
// (the embedding model is multilingual), see 'search_skills finds a skill by a Russian query'.
async function seed(session: string): Promise<void> {
  const created = await rest('POST', '/api/skills', {
    cookie: session,
    form: form(
      { slug: 'code-review', folder: 'general' },
      {
        'SKILL.md': skillMd('code-review', 'Проводит ревью кода перед мержем'),
        'references/a.md': '# Checklist v1\n',
      },
    ),
  });
  expect(created.status).toBe(201);
  const published = await rest('PUT', '/api/skills/code-review', {
    cookie: session,
    form: form(
      { baseVersion: '1', message: 'v2' },
      {
        'SKILL.md': skillMd('code-review', 'Проводит ревью кода перед мержем', 'Read a.md.'),
        'references/a.md': '# Checklist v2\n',
        'assets/logo.png': PNG,
      },
    ),
  });
  expect(published.status).toBe(200);
  const pdf = await rest('POST', '/api/skills', {
    cookie: session,
    form: form(
      { slug: 'pdf', folder: 'general' },
      { 'SKILL.md': skillMd('pdf', 'Extract text from PDF files') },
    ),
  });
  expect(pdf.status).toBe(201);
  // The outbox worker is not running in tests: index directly, as it would.
  await indexSkill(container.search, { slug: 'code-review' });
  await indexSkill(container.search, { slug: 'pdf' });
}

type Era = 'legacy' | 'modern';

async function connect(token: string | null, era: Era = 'legacy'): Promise<Client> {
  const headers: Record<string, string> = {};
  if (token !== null) headers['Authorization'] = `Bearer ${token}`;
  const transport = new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`), {
    requestInit: { headers },
  });
  const client = new Client(
    { name: 'test', version: '1.0.0' },
    era === 'modern' ? { versionNegotiation: { mode: { pin: '2026-07-28' } } } : {},
  );
  await client.connect(transport);
  clients.push(client);
  return client;
}

/** HTTP status the real client fails to connect with. */
async function connectStatus(token: string | null): Promise<number> {
  try {
    await connect(token);
  } catch (e) {
    if (e instanceof SdkHttpError) return e.status;
    throw e;
  }
  throw new Error('connected');
}

const ToolResult = z.object({
  isError: z.boolean().optional(),
  content: z.array(z.object({ type: z.string(), text: z.string().optional() })),
  structuredContent: z.record(z.string(), z.unknown()).optional(),
});
type ToolResult = z.infer<typeof ToolResult>;
const SearchResults = z.strictObject({
  results: z.array(
    z.strictObject({
      slug: z.string(),
      name: z.string(),
      description: z.string(),
      folder: z.string(),
      score: z.number(),
    }),
  ),
});
const FoldersPayload = z.strictObject({
  folders: z.array(
    z.strictObject({
      slug: z.string(),
      name: z.string(),
      description: z.string(),
      skills: z.number(),
    }),
  ),
});
const SkillPayload = z.strictObject({
  slug: z.string(),
  version: z.number(),
  name: z.string(),
  description: z.string(),
  skillMd: z.string(),
  folder: z.string(),
  files: z.array(z.strictObject({ path: z.string(), size: z.number() })),
});

async function callTool(client: Client, name: string, args: Record<string, unknown>) {
  return ToolResult.parse(await client.callTool({ name, arguments: args }));
}

const textOf = (r: ToolResult) => r.content.map((c) => c.text ?? '').join('');

/** A raw JSON-RPC initialize, for the header checks the SDK client cannot vary. */
const initialize = (headers: Record<string, string>) =>
  fetch(`${baseUrl}/mcp`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      ...headers,
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2025-06-18',
        capabilities: {},
        clientInfo: { name: 'raw', version: '1' },
      },
    }),
  });

describe('MCP auth', () => {
  it('rejects a connection without a token with 401 and WWW-Authenticate: Bearer', async () => {
    expect(await connectStatus(null)).toBe(401);
    const res = await initialize({});
    expect(res.status).toBe(401);
    expect(res.headers.get('www-authenticate')).toBe('Bearer');
  });

  it('rejects an unknown and a revoked token with 401', async () => {
    const session = await login();
    const { id, token } = await newToken(session);
    expect(await connectStatus('sk_not-a-real-token')).toBe(401);
    await (await connect(token)).listTools();
    expect((await rest('DELETE', `/api/tokens/${id}`, { cookie: session })).status).toBe(204);
    expect(await connectStatus(token)).toBe(401);
  });

  it('answers 429 with Retry-After once the token limiter trips', async () => {
    const failures = await Promise.all(
      Array.from({ length: 30 }, () => initialize({ authorization: 'Bearer sk_wrong' })),
    );
    const statuses = failures.map((r) => r.status);
    expect(new Set(statuses)).toEqual(new Set([401]));
    const last = await initialize({ authorization: 'Bearer sk_wrong' });
    expect(last.status).toBe(429);
    expect(Number(last.headers.get('retry-after'))).toBeGreaterThan(0);
  });

  it('rejects a foreign Host and a foreign Origin with 403; allows the public Origin', async () => {
    const { token } = await newToken(await login());
    const auth = { authorization: `Bearer ${token}` };
    // fetch() does not let a caller set Host; a raw request goes through the app instead.
    const { app } = createHttpApp(container);
    const evilHost = await app.request('/mcp', {
      method: 'POST',
      headers: { host: 'evil.example', 'content-type': 'application/json', ...auth },
      body: '{}',
    });
    expect(evilHost.status).toBe(403);
    expect((await initialize({ ...auth, origin: 'https://evil.example' })).status).toBe(403);
    expect((await initialize({ ...auth, origin: PUBLIC_ORIGIN })).status).toBe(200);
  });

  it('is not subject to the /api CSRF check (no Origin is fine)', async () => {
    const { token } = await newToken(await login());
    expect((await initialize({ authorization: `Bearer ${token}` })).status).toBe(200);
  });

  it('applies the 1 MiB body limit', async () => {
    const { token } = await newToken(await login());
    const res = await fetch(`${baseUrl}/mcp`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping', pad: 'x'.repeat(1_100_000) }),
    });
    expect(res.status).toBe(413);
  });

  it('never logs the token', async () => {
    const { token } = await newToken(await login());
    const client = await connect(token);
    await client.listTools();
    expect(logLines.some((l) => l.includes(token))).toBe(false);
  });
});

describe.each<Era>(['legacy', 'modern'])('MCP tools (%s era)', (era) => {
  let client: Client;
  let session: string;

  beforeEach(async () => {
    session = await login();
    await seed(session);
    client = await connect((await newToken(session)).token, era);
    expect(client.getProtocolEra()).toBe(era);
  });

  it('exposes get_skill, list_folders and search_skills, with the server instructions', async () => {
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).toSorted()).toEqual([
      'get_skill',
      'list_folders',
      'search_skills',
    ]);
    expect(client.getInstructions()).toBe(SERVER_INSTRUCTIONS);
    expect(SERVER_INSTRUCTIONS).toContain('list_folders');
    for (const t of tools) expect(t.annotations?.readOnlyHint).toBe(true);
    expect(tools.find((t) => t.name === 'search_skills')?.description).toBe(
      "Search the user's skill library. Returns only skills that passed a relevance threshold, best first, with slug, name, description, folder and a score from 0 to 1 (1 = top match by both keyword and meaning, up to 0.5 = matched by one of them). An empty list means no skill fits. Optional folders (slugs from list_folders) limits the search to those folders.",
    );
    expect(tools.find((t) => t.name === 'list_folders')?.description).toBe(
      "List the active folders that group the user's skills by topic or project: slug, name, description and number of skills. Use the slugs as search_skills folders when the task clearly belongs to some of them.",
    );
  });

  async function addDevops(): Promise<void> {
    const made = await Promise.all(
      (
        [
          ['devops', 'DevOps'],
          ['archived', 'Archived'],
          ['empty', 'Empty'],
        ] as const
      ).map(([slug, name]) =>
        rest('POST', '/api/folders', {
          cookie: session,
          body: { slug, name, description: `${name} folder` },
        }),
      ),
    );
    expect(made.map((r) => r.status)).toEqual([201, 201, 201]);
    const created = await rest('POST', '/api/skills', {
      cookie: session,
      form: form(
        { slug: 'deploy', folder: 'devops' },
        { 'SKILL.md': skillMd('deploy', 'Проводит ревью кода при деплое') },
      ),
    });
    expect(created.status).toBe(201);
    await indexSkill(container.search, { slug: 'deploy' });
    const arch = await rest('POST', '/api/folders/archived/archive', { cookie: session });
    expect(arch.status).toBe(200);
  }

  it('list_folders returns only active folders by name with active skill counts', async () => {
    await addDevops();
    const r = await callTool(client, 'list_folders', {});
    expect(r.isError).toBeFalsy();
    const { folders } = FoldersPayload.parse(r.structuredContent);
    expect(folders).toEqual([
      { slug: 'devops', name: 'DevOps', description: 'DevOps folder', skills: 1 },
      { slug: 'empty', name: 'Empty', description: 'Empty folder', skills: 0 },
      expect.objectContaining({ slug: 'general', skills: 2 }),
    ]);
    expect(JSON.parse(textOf(r))).toEqual({ folders });
  });

  it('search_skills limits the search to folders and returns the folder', async () => {
    await addDevops();
    const all = SearchResults.parse(
      (await callTool(client, 'search_skills', { query: 'ревью кода' })).structuredContent,
    );
    expect(all.results.map((x) => x.slug).toSorted()).toEqual(['code-review', 'deploy']);
    const r = await callTool(client, 'search_skills', {
      query: 'ревью кода',
      folders: ['devops'],
    });
    const { results } = SearchResults.parse(r.structuredContent);
    expect(results.map((x) => [x.slug, x.folder])).toEqual([['deploy', 'devops']]);
    const dup = SearchResults.parse(
      (
        await callTool(client, 'search_skills', {
          query: 'ревью кода',
          folders: ['devops', 'devops'],
        })
      ).structuredContent,
    );
    expect(dup.results.map((x) => x.slug)).toEqual(['deploy']);
    const none = await callTool(client, 'search_skills', {
      query: 'ревью кода',
      folders: ['empty'],
    });
    expect(SearchResults.parse(none.structuredContent).results).toEqual([]);
  });

  it('search_skills rejects unknown, archived and wrongly cased folders', async () => {
    await addDevops();
    const slugs = ['nope', 'archived', 'DevOps'];
    const rs = await Promise.all(
      slugs.map((slug) => callTool(client, 'search_skills', { query: 'x', folders: [slug] })),
    );
    expect(rs.map((r) => [r.isError, textOf(r)])).toEqual(
      slugs.map((slug) => [true, `Unknown folder "${slug}". Call list_folders.`]),
    );
    const mixed = await callTool(client, 'search_skills', {
      query: 'x',
      folders: ['devops', 'nope'],
    });
    expect(textOf(mixed)).toBe('Unknown folder "nope". Call list_folders.');
  });

  it('search_skills validates the folders array bounds', async () => {
    expect((await callTool(client, 'search_skills', { query: 'x', folders: [] })).isError).toBe(
      true,
    );
    const many = Array.from({ length: 21 }, (_, i) => `f${i}`);
    expect((await callTool(client, 'search_skills', { query: 'x', folders: many })).isError).toBe(
      true,
    );
  });

  it('search_skills finds a skill by a Russian query', async () => {
    const r = await callTool(client, 'search_skills', { query: 'ревью кода' });
    expect(r.isError).toBeFalsy();
    const { results } = SearchResults.parse(r.structuredContent);
    expect(results[0]?.slug).toBe('code-review');
    expect(JSON.parse(textOf(r))).toEqual({ results });
  });

  it('search_skills validates limit (max 25)', async () => {
    const r = await callTool(client, 'search_skills', { query: 'x', limit: 26 });
    expect(r.isError).toBe(true);
  });

  it('get_skill returns the latest version with SKILL.md and the other files', async () => {
    const r = await callTool(client, 'get_skill', { slug: 'code-review' });
    expect(r.isError).toBeFalsy();
    const s = SkillPayload.parse(r.structuredContent);
    expect(s.slug).toBe('code-review');
    expect(s.folder).toBe('general');
    expect(s.version).toBe(2);
    expect(s.name).toBe('code-review');
    expect(s.skillMd.startsWith('---')).toBe(true);
    expect(s.skillMd).toContain('Read a.md.');
    expect(s.files.map((f) => f.path).toSorted()).toEqual(['assets/logo.png', 'references/a.md']);
    expect(s.files.find((f) => f.path === 'assets/logo.png')).toEqual({
      path: 'assets/logo.png',
      size: PNG.length,
    });
    expect(JSON.parse(textOf(r))).toEqual(s);

    const put = await rest('PUT', '/api/skills/code-review', {
      cookie: session,
      form: form(
        { baseVersion: '2', message: 'v3' },
        { 'SKILL.md': skillMd('code-review', 'Проводит ревью кода перед мержем', 'v3.') },
      ),
    });
    expect(put.status).toBe(200);
    const latest = SkillPayload.parse(
      (await callTool(client, 'get_skill', { slug: 'code-review' })).structuredContent,
    );
    expect(latest.version).toBe(3);
    expect(latest.skillMd).toContain('v3.');
    expect(latest.files).toEqual([]);
  });

  it('get_skill with a path returns the text file; rejects traversal and binary files', async () => {
    const file = await callTool(client, 'get_skill', {
      slug: 'code-review',
      path: './references/a.md',
    });
    expect(file.isError).toBeFalsy();
    expect(textOf(file)).toBe('# Checklist v2\n');

    const traversal = await callTool(client, 'get_skill', { slug: 'code-review', path: '../x' });
    expect(traversal.isError).toBe(true);
    expect(textOf(traversal)).toMatch(/Invalid path/);

    const missing = await callTool(client, 'get_skill', { slug: 'code-review', path: 'nope.md' });
    expect(missing.isError).toBe(true);
    expect(textOf(missing)).toBe('File "nope.md" not found in skill "code-review".');

    const binary = await callTool(client, 'get_skill', {
      slug: 'code-review',
      path: 'assets/logo.png',
    });
    expect(binary.isError).toBe(true);
    expect(textOf(binary)).toBe(`Binary file, ${PNG.length} bytes. Available only in the web UI.`);
  });

  it('hides internal error details from the client and from the log', async () => {
    vi.spyOn(container.catalog.skills, 'findBySlug').mockRejectedValueOnce(
      new TypeError('invalid input syntax for type uuid: "secret-value-xyz"'),
    );
    const r = await callTool(client, 'get_skill', { slug: 'code-review' });
    expect(r.isError).toBe(true);
    expect(textOf(r)).toBe('Internal error.');
    const line = logLines.find((l) => l.includes('mcp tool failed')) ?? '';
    expect(JSON.parse(line)).toMatchObject({
      tool: 'get_skill',
      err: { name: 'TypeError', frames: expect.arrayContaining([expect.stringMatching(/^at /)]) },
    });
    expect(logLines.join('\n')).not.toContain('secret-value-xyz');
  });

  it('hides archived and unknown skills', async () => {
    expect((await rest('POST', '/api/skills/pdf/archive', { cookie: session })).status).toBe(204);
    await indexSkill(container.search, { slug: 'pdf' });

    const search = await callTool(client, 'search_skills', { query: 'extract text from pdf' });
    const slugs = SearchResults.parse(search.structuredContent).results.map((x) => x.slug);
    expect(slugs).not.toContain('pdf');

    const archived = await callTool(client, 'get_skill', { slug: 'pdf' });
    expect(archived.isError).toBe(true);
    expect(textOf(archived)).toBe('Skill "pdf" not found.');
    const archivedFile = await callTool(client, 'get_skill', { slug: 'pdf', path: 'SKILL.md' });
    expect(archivedFile.isError).toBe(true);
    expect(textOf(archivedFile)).toBe('Skill "pdf" not found.');

    const unknown = await callTool(client, 'get_skill', { slug: 'no-such-skill' });
    expect(textOf(unknown)).toBe('Skill "no-such-skill" not found.');
    const invalid = await callTool(client, 'get_skill', { slug: 'Not A Slug' });
    expect(textOf(invalid)).toBe('Skill "Not A Slug" not found.');
  });
});
