import { describe, expect, it } from 'vite-plus/test';
import { fakeEnv } from '../../test/fake-env.ts';
import {
  formOf,
  json,
  type Recorded,
  recordingFetch,
  skillView,
} from '../../test/registry-fixtures.ts';
import { fakeGithub, tarball } from '../../test/tarball.ts';
import { runCli } from '../cli.ts';

const SHA = 'abcdef0123456789abcdef0123456789abcdef01';
const skillMd = (name: string, description = `About ${name}`) =>
  `---\nname: ${name}\ndescription: ${description}\n---\n# ${name}\n`;

const github = fakeGithub({
  'anthropics/skills': {
    defaultBranch: 'main',
    refs: { main: SHA },
    tarballs: {
      [SHA]: tarball([
        { path: 'skills/mcp-builder/SKILL.md', content: skillMd('mcp-builder') },
        { path: 'skills/mcp-builder/reference/guide.md', content: 'guide' },
        { path: 'skills/mcp-builder/link', type: '2', linkname: '/etc/passwd' },
        { path: 'skills/pdf/SKILL.md', content: skillMd('pdf') },
      ]),
    },
  },
  'o/r': {
    defaultBranch: 'main',
    refs: { main: SHA },
    tarballs: { [SHA]: tarball([{ path: 'SKILL.md', content: skillMd('root-skill') }]) },
  },
});

type Folder = { slug: string; status: 'active' | 'archived' };

function setup(state: { skills?: string[]; folders?: Folder[]; failSkill?: boolean } = {}) {
  const registry = recordingFetch((r: Recorded) => {
    const { pathname } = new URL(r.url);
    if (r.method === 'GET' && pathname.startsWith('/api/skills/')) {
      const slug = decodeURIComponent(pathname.slice('/api/skills/'.length));
      return state.skills?.includes(slug)
        ? json(200, skillView(slug))
        : json(404, { error: { code: 'not_found', message: 'no' } });
    }
    if (r.method === 'GET' && pathname === '/api/folders') {
      return json(
        200,
        (state.folders ?? []).map((f) => ({
          slug: f.slug,
          name: f.slug,
          description: '',
          status: f.status,
          skills: { active: 0, archived: 0 },
        })),
      );
    }
    if (r.method === 'POST' && pathname === '/api/folders') {
      const body = new Map(Object.entries(r.body ?? {}));
      state.folders = [
        ...(state.folders ?? []),
        { slug: String(body.get('slug')), status: 'active' },
      ];
      return json(201, { slug: body.get('slug'), name: body.get('name') });
    }
    if (r.method === 'POST' && pathname === '/api/skills') {
      if (state.failSkill) return json(422, { error: { code: 'invalid_skill', message: 'bad' } });
      return json(201, { slug: formOf(r).get('slug'), version: 1 });
    }
    return json(500, { error: { code: 'unexpected', message: `${r.method} ${r.url}` } });
  });
  const env = fakeEnv({
    fetch: (input, init) => {
      const url = input instanceof Request ? input.url : input.toString();
      return url.startsWith('http://gh.test')
        ? github.fetch(input, init)
        : registry.fetch(input, init);
    },
    vars: {
      SKILLS_REGISTRY_URL: 'http://reg.test',
      SKILLS_REGISTRY_TOKEN: 'sk_t',
      GITHUB_API_URL: 'http://gh.test',
    },
  });
  const posts = () => registry.requests.filter((r) => r.method !== 'GET');
  return { env, posts };
}

describe('import', () => {
  it('creates a folder named after the skill, then the skill with its source', async () => {
    const { env, posts } = setup();
    expect(await runCli(['import', 'anthropics/skills', '--skill', 'mcp-builder'], env)).toBe(0);
    const [folder, skill] = posts();
    expect(folder?.url).toBe('http://reg.test/api/folders');
    expect(folder?.body).toEqual({
      slug: 'mcp-builder',
      name: 'mcp-builder',
      description: 'About mcp-builder',
    });
    const form = formOf(skill);
    expect(form.get('slug')).toBe('mcp-builder');
    expect(form.get('folder')).toBe('mcp-builder');
    expect(form.get('message')).toBe('import from anthropics/skills/skills/mcp-builder@abcdef0');
    expect(form.get('sourceHost')).toBe('github.com');
    expect(form.get('sourceRepo')).toBe('anthropics/skills');
    expect(form.get('sourcePath')).toBe('skills/mcp-builder');
    expect(form.get('sourceRef')).toBeNull();
    expect(form.get('sourceCommit')).toBe(SHA);
    expect([...form.keys()].filter((k) => k.includes('.') || k === 'link').toSorted()).toEqual([
      'SKILL.md',
      'reference/guide.md',
    ]);
    expect(env.stdout).toEqual([
      'created mcp-builder v1 in folder mcp-builder (new) from anthropics/skills/skills/mcp-builder@abcdef0 (2 files)',
    ]);
    expect(env.stderr).toEqual([
      'skipped (not a regular file or path the registry would change): link',
    ]);
  });

  it('imports a skill at the repository root with a label without an extra slash', async () => {
    const { env, posts } = setup();
    expect(await runCli(['import', 'https://github.com/o/r'], env)).toBe(0);
    const form = formOf(posts()[1]);
    expect(form.get('message')).toBe('import from o/r@abcdef0');
    expect(form.get('sourcePath')).toBe('');
  });

  it('with --folder of an existing folder creates no folder', async () => {
    const { env, posts } = setup({ folders: [{ slug: 'design', status: 'active' }] });
    expect(
      await runCli(['import', 'anthropics/skills', '--skill', 'pdf', '--folder', 'design'], env),
    ).toBe(0);
    expect(posts().map((r) => r.url)).toEqual(['http://reg.test/api/skills']);
    expect(formOf(posts()[0]).get('folder')).toBe('design');
    expect(env.stdout[0]).toContain('in folder design (existing)');
  });

  it('creates a missing --folder, then the skill in it', async () => {
    const { env, posts } = setup();
    expect(
      await runCli(['import', 'anthropics/skills', '--skill', 'pdf', '--folder', 'design'], env),
    ).toBe(0);
    const [folder, skill] = posts();
    expect(folder?.url).toBe('http://reg.test/api/folders');
    expect(folder?.body).toEqual({
      slug: 'design',
      name: 'design',
      description: 'skills imported from anthropics/skills',
    });
    expect(formOf(skill).get('slug')).toBe('pdf');
    expect(formOf(skill).get('folder')).toBe('design');
    expect(env.stdout).toEqual([
      'created pdf v1 in folder design (new) from anthropics/skills/skills/pdf@abcdef0 (1 files)',
    ]);
  });

  it('--dry-run with a missing --folder says (new) and posts nothing', async () => {
    const { env, posts } = setup();
    const args = ['import', 'anthropics/skills', '--skill', 'pdf', '--folder', 'design'];
    expect(await runCli([...args, '--dry-run'], env)).toBe(0);
    expect(posts()).toEqual([]);
    expect(env.stdout[0]).toBe(
      'would create pdf in folder design (new) from anthropics/skills/skills/pdf@abcdef0',
    );
  });

  it('an archived --folder fails with 1', async () => {
    const { env, posts } = setup({ folders: [{ slug: 'design', status: 'archived' }] });
    const args = ['import', 'anthropics/skills', '--skill', 'pdf', '--folder', 'design'];
    expect(await runCli(args, env)).toBe(1);
    expect(env.stderr).toEqual(['folder "design" is archived']);
    expect(posts()).toEqual([]);
  });

  it('several --skill with a missing --folder create it once', async () => {
    const { env, posts } = setup();
    const args = ['import', 'anthropics/skills', '--skill', 'mcp-builder', '--skill', 'pdf'];
    expect(await runCli([...args, '--folder', 'design'], env)).toBe(0);
    expect(posts().map((r) => new URL(r.url).pathname)).toEqual([
      '/api/folders',
      '/api/skills',
      '/api/skills',
    ]);
    expect(
      posts()
        .slice(1)
        .map((r) => formOf(r).get('folder')),
    ).toEqual(['design', 'design']);
    expect(env.stdout).toEqual([
      'created mcp-builder v1 in folder design (new) from anthropics/skills/skills/mcp-builder@abcdef0 (2 files)',
      'created pdf v1 in folder design (existing) from anthropics/skills/skills/pdf@abcdef0 (1 files)',
      'created 2, conflicts 0, failed 0',
    ]);
  });

  it('several --skill --dry-run with a missing --folder post nothing', async () => {
    const { env, posts } = setup();
    const args = ['import', 'anthropics/skills', '--skill', 'mcp-builder', '--skill', 'pdf'];
    expect(await runCli([...args, '--folder', 'design', '--dry-run'], env)).toBe(0);
    expect(posts()).toEqual([]);
    expect(env.stdout.filter((l) => l.startsWith('would create '))).toEqual([
      'would create mcp-builder in folder design (new) from anthropics/skills/skills/mcp-builder@abcdef0',
      'would create pdf in folder design (new) from anthropics/skills/skills/pdf@abcdef0',
      'would create 2, conflicts 0, failed 0',
    ]);
  });

  it('an existing skill is a conflict and creates nothing', async () => {
    const { env, posts } = setup({ skills: ['pdf'] });
    expect(await runCli(['import', 'anthropics/skills', '--skill', 'pdf'], env)).toBe(1);
    expect(env.stderr).toEqual(['conflict: skill "pdf" already exists']);
    expect(posts()).toEqual([]);
  });

  it('an existing folder (archived too) without --folder is a conflict with a hint', async () => {
    const { env, posts } = setup({ folders: [{ slug: 'pdf', status: 'archived' }] });
    expect(await runCli(['import', 'anthropics/skills', '--skill', 'pdf'], env)).toBe(1);
    expect(env.stderr).toEqual(['conflict: folder "pdf" already exists; pass --folder <slug>']);
    expect(posts()).toEqual([]);
  });

  it('--dry-run checks and prints but posts nothing', async () => {
    const { env, posts } = setup();
    expect(
      await runCli(['import', 'anthropics/skills', '--skill', 'mcp-builder', '--dry-run'], env),
    ).toBe(0);
    expect(posts()).toEqual([]);
    expect(env.stdout).toEqual([
      'would create mcp-builder in folder mcp-builder (new) from anthropics/skills/skills/mcp-builder@abcdef0',
      `  SKILL.md\t${skillMd('mcp-builder').length}`,
      '  reference/guide.md\t5',
    ]);
  });

  it('reports the empty folder when the skill could not be created', async () => {
    const { env } = setup({ failSkill: true });
    expect(await runCli(['import', 'anthropics/skills', '--skill', 'pdf'], env)).toBe(1);
    expect(env.stderr).toEqual([
      'folder "pdf" was created but the skill was not; archive it in the UI if not needed',
      'error: bad',
    ]);
  });

  it('reports the empty --folder it created when the skill could not be created', async () => {
    const { env } = setup({ failSkill: true });
    const args = ['import', 'anthropics/skills', '--skill', 'pdf', '--folder', 'design'];
    expect(await runCli(args, env)).toBe(1);
    expect(env.stderr).toEqual([
      'folder "design" was created but the skill was not; archive it in the UI if not needed',
      'error: bad',
    ]);
  });

  it('several --skill are independent and summarised', async () => {
    const { env } = setup({ skills: ['pdf'] });
    const args = ['import', 'anthropics/skills', '--skill', 'mcp-builder', '--skill', 'pdf'];
    expect(await runCli([...args, '--skill', 'nope'], env)).toBe(1);
    expect(env.stdout.at(-1)).toBe('created 1, conflicts 1, failed 1');
    expect(env.stderr).toContain('error: skill "nope" not found in anthropics/skills');
  });

  it('several --skill resolve the commit once and read the tarball once', async () => {
    const { env } = setup();
    const before = github.requests.length;
    const args = ['import', 'anthropics/skills', '--skill', 'mcp-builder', '--skill', 'pdf'];
    expect(await runCli(args, env)).toBe(0);
    const urls = github.requests.slice(before).map((r) => new URL(r.url).pathname);
    expect(urls.filter((u) => u.includes('/commits/'))).toHaveLength(1);
    expect(urls.filter((u) => u.includes('/tarball/'))).toHaveLength(1);
  });

  it('owner/repo without --skill is a usage error', async () => {
    const { env } = setup();
    expect(await runCli(['import', 'anthropics/skills'], env)).toBe(2);
  });
});
