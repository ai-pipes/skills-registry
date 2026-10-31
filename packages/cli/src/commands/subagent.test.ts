import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vite-plus/test';
import { fakeEnv } from '../../test/fake-env.ts';
import {
  json,
  recordingFetch,
  subagentSummary,
  subagentView,
} from '../../test/registry-fixtures.ts';
import { runCli } from '../cli.ts';
import { readInstalled } from '../subagents/installed.ts';

const SERVER = 'https://r.example';

type Def = Record<string, unknown>;

/** A fake registry: `agents[slug]` is the latest view (overrides of the fixture). */
function setup(agents: Record<string, Def>) {
  const reg = recordingFetch((r) => {
    const url = new URL(r.url);
    const all = Object.entries(agents).map(([slug, over]) => subagentView(slug, over));
    if (url.pathname === '/api/subagents') {
      const status = url.searchParams.get('status') ?? 'active';
      const folder = url.searchParams.get('folder');
      return json(
        200,
        all
          .filter((v) => status === 'all' || v.status === status)
          .filter((v) => folder === null || v.folder.slug === folder)
          .map((v) => subagentSummary(v.slug, v)),
      );
    }
    const m = /^\/api\/subagents\/([^/]+)$/.exec(url.pathname);
    const found = all.find((v) => v.slug === m?.[1]);
    return found
      ? json(200, found)
      : json(404, { error: { code: 'not_found', message: 'no such subagent' } });
  });
  const env = fakeEnv({
    fetch: reg.fetch,
    vars: { SKILLS_REGISTRY_URL: SERVER, SKILLS_REGISTRY_TOKEN: 'sk_t' },
  });
  const run = async (...argv: string[]) => {
    env.stdout.length = 0;
    env.stderr.length = 0;
    return runCli(['subagent', ...argv], env);
  };
  const dir = join(env.cwd, '.claude', 'agents');
  const file = (slug: string) => join(dir, `${slug}.md`);
  const text = (slug: string) => readFileSync(file(slug), 'utf8');
  return { env, run, agents, dir, file, text, requests: reg.requests };
}

const A = ['-a', 'claude-code'];
const ENG = { folder: { slug: 'eng', name: 'Eng' } };

describe('subagent dispatcher', () => {
  it('prints usage for --help and fails on a missing or unknown subcommand', async () => {
    const s = setup({});
    expect(await s.run('--help')).toBe(0);
    expect(s.env.stdout.join('\n')).toContain('subagent install');
    expect(await s.run()).toBe(2);
    expect(await s.run('nope')).toBe(2);
    expect(s.env.stderr.join('\n')).toContain('unknown subagent command "nope"');
  });
});

describe('subagent install', () => {
  it('installs one and prints the permissions', async () => {
    const s = setup({ devops: { tools: ['Bash', 'Read'], model: 'sonnet', skills: ['a', 'b'] } });
    expect(await s.run('install', 'devops', ...A), s.env.stderr.join('\n')).toBe(0);
    expect(s.env.stdout).toEqual([
      `installed devops v1 (model sonnet; tools Bash, Read; skills a, b) → ${s.file('devops')}`,
    ]);
    expect(s.text('devops')).toContain('tools: Bash, Read, mcp__skills__get_skill');
    const m = await readInstalled(s.dir);
    expect(m.subagents['devops']).toMatchObject({
      server: SERVER,
      version: 1,
      mcpServer: 'skills',
      tools: ['Bash', 'Read'],
    });
  });

  it('prints all tools and no skills for an unrestricted one', async () => {
    const s = setup({ devops: {} });
    await s.run('install', 'devops', ...A);
    expect(s.env.stdout[0]).toContain('(model inherit; tools all tools; skills none)');
  });

  it('installs several, and the whole --folder', async () => {
    const s = setup({ a: ENG, b: ENG, c: {}, gone: { ...ENG, status: 'archived' } });
    expect(await s.run('install', 'c', '--folder', 'eng', ...A)).toBe(0);
    expect(Object.keys((await readInstalled(s.dir)).subagents).toSorted()).toEqual(['a', 'b', 'c']);
    expect(existsSync(s.file('gone'))).toBe(false);
  });

  it('reports not found and archived, and exits 1 after the others', async () => {
    const s = setup({ ok: {}, old: { status: 'archived' } });
    expect(await s.run('install', 'nope', 'old', 'ok', ...A)).toBe(1);
    expect(s.env.stderr.join('\n')).toContain('error: subagent nope not found');
    expect(s.env.stderr.join('\n')).toContain('error: subagent old is archived');
    expect(existsSync(s.file('ok'))).toBe(true);
  });

  it('says already installed for the same version', async () => {
    const s = setup({ devops: {} });
    await s.run('install', 'devops', ...A);
    expect(await s.run('install', 'devops', ...A)).toBe(0);
    expect(s.env.stdout).toEqual(['devops v1 is already installed']);
  });

  it('applies a newer version over ours and gates a tools change', async () => {
    const s = setup({ devops: { tools: ['Bash', 'Write'] } });
    await s.run('install', 'devops', ...A);
    const before = s.text('devops');
    s.agents['devops'] = { version: 2, tools: ['Bash', 'Read'] };
    expect(await s.run('install', 'devops', ...A)).toBe(1);
    expect(s.env.stderr).toEqual([
      'permissions changed for devops: +Read -Write; rerun with --yes to apply',
    ]);
    expect(s.text('devops')).toBe(before);
    s.agents['devops'] = { version: 2, tools: ['Bash', 'Write'] };
    expect(await s.run('install', 'devops', ...A)).toBe(0);
    expect(s.env.stdout[0]).toMatch(/^updated devops v1 → v2 /);
  });

  it('conflicts over a hand-written file, --force overwrites and records it', async () => {
    const s = setup({ devops: {} });
    mkdirSync(s.dir, { recursive: true });
    writeFileSync(s.file('devops'), 'mine');
    expect(await s.run('install', 'devops', ...A)).toBe(1);
    expect(s.env.stderr).toEqual([
      `conflict: ${s.file('devops')} was not installed by skills-registry or was modified; use --force`,
    ]);
    expect(s.text('devops')).toBe('mine');
    expect(await s.run('install', 'devops', '--force', ...A)).toBe(0);
    expect(s.text('devops')).toContain('name: devops');
    expect((await readInstalled(s.dir)).subagents['devops']?.version).toBe(1);
  });

  it('uses --mcp-server and records it', async () => {
    const s = setup({ devops: { skills: ['a'] } });
    await s.run('install', 'devops', '--mcp-server', 'registry', ...A);
    expect(s.text('devops')).toContain('`registry` MCP server');
    expect((await readInstalled(s.dir)).subagents['devops']?.mcpServer).toBe('registry');
  });

  it('rejects an invalid --mcp-server and slug with exit 2, before any request', async () => {
    const s = setup({ devops: {} });
    expect(await s.run('install', 'devops', '--mcp-server', 'a b', ...A)).toBe(2);
    expect(await s.run('install', '../x', ...A)).toBe(2);
    expect(s.env.stderr.join('\n')).toContain('invalid subagent slug "../x"');
    expect(await s.run('install')).toBe(2);
    expect(s.requests).toEqual([]);
  });

  it('rejects another agent with exit 2', async () => {
    const s = setup({ devops: {} });
    expect(await s.run('install', 'devops', '-a', 'cursor')).toBe(2);
    expect(s.env.stderr.join('\n')).toContain(
      'cursor does not support subagents (supported: claude-code)',
    );
  });

  it('asks for -a when ~/.claude is missing and detects it otherwise', async () => {
    const s = setup({ devops: {} });
    expect(await s.run('install', 'devops')).toBe(2);
    mkdirSync(join(s.env.home, '.claude'));
    expect(await s.run('install', 'devops')).toBe(0);
  });

  it('-g writes under home', async () => {
    const s = setup({ devops: {} });
    expect(await s.run('install', 'devops', '-g', ...A)).toBe(0);
    expect(existsSync(join(s.env.home, '.claude', 'agents', 'devops.md'))).toBe(true);
    expect(existsSync(s.file('devops'))).toBe(false);
  });
});

describe('subagent update', () => {
  it('is up to date without changes', async () => {
    const s = setup({ devops: {} });
    await s.run('install', 'devops', ...A);
    expect(await s.run('update')).toBe(0);
    expect(s.env.stdout).toEqual(['devops is up to date (v1)']);
  });

  it('updates all, skipping a hand-edited file, exit 1', async () => {
    const s = setup({ a: {}, b: {}, c: {} });
    await s.run('install', 'a', 'b', 'c', ...A);
    writeFileSync(s.file('b'), `${s.text('b')}\nmy edit`);
    s.agents['a'] = { version: 2, description: 'new words' };
    s.agents['b'] = { version: 2 };
    s.agents['c'] = { version: 3, model: 'haiku' };
    expect(await s.run('update')).toBe(1);
    expect(s.env.stdout).toEqual(['updated a v1 → v2 (description)', 'updated c v1 → v3 (model)']);
    expect(s.env.stderr).toEqual([
      `conflict: ${s.file('b')} was not installed by skills-registry or was modified; reinstall with install --force`,
    ]);
    expect(s.text('b')).toContain('my edit');
    expect(s.text('a')).toContain('description: new words');
    const m = (await readInstalled(s.dir)).subagents;
    expect([m['a']?.version, m['b']?.version, m['c']?.version]).toEqual([2, 1, 3]);
  });

  it('holds back a tools change without --yes and applies it with --yes', async () => {
    const s = setup({ devops: { tools: ['Read'] }, other: {} });
    await s.run('install', 'devops', 'other', ...A);
    const before = s.text('devops');
    s.agents['devops'] = { version: 2, tools: ['Bash', 'Read'] };
    s.agents['other'] = { version: 2, description: 'changed' };
    expect(await s.run('update')).toBe(1);
    expect(s.env.stderr).toEqual([
      'permissions changed for devops: +Bash; rerun with --yes to apply',
    ]);
    expect(s.text('devops')).toBe(before);
    expect(s.text('other')).toContain('description: changed');
    expect(await s.run('update', 'devops', '--yes')).toBe(0);
    expect(s.env.stdout).toEqual(['updated devops v1 → v2 (tools)']);
    expect(s.text('devops')).toContain('tools: Bash, Read');
    expect((await readInstalled(s.dir)).subagents['devops']?.tools).toEqual(['Bash', 'Read']);
  });

  it('gates a change between inheriting all tools and a list', async () => {
    const s = setup({ devops: {} });
    await s.run('install', 'devops', ...A);
    s.agents['devops'] = { version: 2, tools: ['Read'] };
    expect(await s.run('update')).toBe(1);
    expect(s.env.stderr[0]).toBe(
      'permissions changed for devops: all tools → Read; rerun with --yes to apply',
    );
    expect(await s.run('update', '--yes')).toBe(0);
    s.agents['devops'] = { version: 3 };
    expect(await s.run('update')).toBe(1);
    expect(s.env.stderr[0]).toBe(
      'permissions changed for devops: Read → all tools; rerun with --yes to apply',
    );
  });

  it('applies without the gate when only the skills changed', async () => {
    const s = setup({ devops: { tools: ['Read'], skills: ['a'] } });
    await s.run('install', 'devops', ...A);
    s.agents['devops'] = { version: 2, tools: ['Read'], skills: ['a', 'b'] };
    expect(await s.run('update')).toBe(0);
    expect(s.env.stdout).toEqual(['updated devops v1 → v2 (skills)']);
    expect(s.text('devops')).toContain('`a`, `b`');
  });

  it('lists several changed fields, and a changed prompt', async () => {
    const s = setup({ devops: {} });
    await s.run('install', 'devops', ...A);
    s.agents['devops'] = {
      version: 2,
      model: 'opus',
      content: '---\nname: devops\ndescription: About devops\n---\nNew prompt.\n',
    };
    await s.run('update');
    expect(s.env.stdout).toEqual(['updated devops v1 → v2 (model, prompt)']);
  });

  it('reuses the recorded MCP server name', async () => {
    const s = setup({ devops: { skills: ['a'] } });
    await s.run('install', 'devops', '--mcp-server', 'registry', ...A);
    s.agents['devops'] = { version: 2, skills: ['a', 'b'] };
    await s.run('update');
    expect(s.text('devops')).toContain('`registry` MCP server');
  });

  it('fails for a slug that is not installed, missing or archived', async () => {
    const s = setup({ a: {}, b: {} });
    await s.run('install', 'a', 'b', ...A);
    expect(await s.run('update', 'zzz')).toBe(1);
    expect(s.env.stderr.join('\n')).toContain('error: zzz is not installed');
    delete s.agents['a'];
    s.agents['b'] = { status: 'archived' };
    expect(await s.run('update')).toBe(1);
    expect(s.env.stderr.join('\n')).toContain('error: a is no longer in the registry');
    expect(s.env.stderr.join('\n')).toContain('error: b is archived in the registry');
  });

  it('does nothing when nothing is installed', async () => {
    const s = setup({});
    expect(await s.run('update')).toBe(0);
    expect(s.env.stdout).toEqual(['no subagents installed']);
  });
});

describe('subagent uninstall', () => {
  it('removes ours and the manifest entry, reports a foreign file and exits 1', async () => {
    const s = setup({ a: {}, b: {} });
    await s.run('install', 'a', 'b', ...A);
    writeFileSync(s.file('b'), 'edited');
    expect(await s.run('uninstall', 'a', 'b', 'ghost', ...A)).toBe(1);
    expect(s.env.stdout).toEqual([`removed ${s.file('a')}`, 'ghost is not installed']);
    expect(s.env.stderr).toEqual([`skipped ${s.file('b')}: not installed by skills-registry`]);
    expect(existsSync(s.file('a'))).toBe(false);
    expect(s.text('b')).toBe('edited');
    expect(Object.keys((await readInstalled(s.dir)).subagents)).toEqual(['b']);
  });

  it('does not touch a file the CLI never wrote', async () => {
    const s = setup({});
    mkdirSync(s.dir, { recursive: true });
    writeFileSync(s.file('mine'), 'x');
    expect(await s.run('uninstall', 'mine', ...A)).toBe(1);
    expect(s.text('mine')).toBe('x');
  });

  it('--folder removes installed subagents the registry lists in that folder', async () => {
    const s = setup({ a: ENG, b: ENG, c: {} });
    await s.run('install', 'a', 'b', 'c', ...A);
    s.agents['b'] = { ...ENG, status: 'archived' };
    expect(await s.run('uninstall', '--folder', 'eng', ...A)).toBe(0);
    expect(Object.keys((await readInstalled(s.dir)).subagents)).toEqual(['c']);
  });

  it('needs a slug or --folder', async () => {
    const s = setup({});
    expect(await s.run('uninstall', ...A)).toBe(2);
  });
});

describe('subagent list', () => {
  it('lists active subagents, optionally by folder', async () => {
    const s = setup({
      a: { version: 4, description: 'Does\x1b[31m a' },
      b: ENG,
      old: { status: 'archived' },
    });
    expect(await s.run('list')).toBe(0);
    expect(s.env.stdout).toEqual(['a\tv4\tdesign\tDoes?[31m a', 'b\tv1\teng\tAbout b']);
    await s.run('list', '--folder', 'eng');
    expect(s.env.stdout).toEqual(['b\tv1\teng\tAbout b']);
  });

  it('--installed merges the manifest with the registry', async () => {
    const s = setup({ ok: {}, newer: {}, edited: {}, arch: {}, gone: {}, lost: {} });
    await s.run('install', 'ok', 'newer', 'edited', 'arch', 'gone', 'lost', ...A);
    writeFileSync(s.file('edited'), 'x');
    rmSync(s.file('lost'));
    s.agents['newer'] = { version: 5 };
    s.agents['arch'] = { status: 'archived' };
    delete s.agents['gone'];
    expect(await s.run('list', '--installed')).toBe(0);
    expect(s.env.stdout).toEqual([
      'arch\tv1\tv1\tarchived',
      'edited\tv1\tv1\tmodified',
      'gone\tv1\t-\tmissing',
      'lost\tv1\tv1\tdeleted',
      'newer\tv1\tv5 ↑\tok',
      'ok\tv1\tv1\tok',
    ]);
  });

  it('--installed is empty when nothing is installed', async () => {
    const s = setup({});
    expect(await s.run('list', '--installed')).toBe(0);
    expect(s.env.stdout).toEqual([]);
  });
});
