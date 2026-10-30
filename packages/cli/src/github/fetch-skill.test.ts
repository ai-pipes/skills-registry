import { describe, expect, it } from 'vite-plus/test';
import { fakeGithub, type FakeRepo, type TarEntry, tarball } from '../../test/tarball.ts';
import { UsageError } from '../args.ts';
import { GithubClient } from './client.ts';
import { fetchSkill, fetchSkills } from './fetch-skill.ts';
import { parseFrontmatter } from './frontmatter.ts';
import { parseSource } from './source.ts';

const SHA = 'c0ffee'.padEnd(40, '0');
const skillMd = (name: string) =>
  `---\nname: ${name}\ndescription: About ${name}\n---\n# ${name}\n`;
const MAX = { compressedBytes: 209_715_200, unpackedBytes: 1_073_741_824 };

function repoWith(entries: TarEntry[]): FakeRepo {
  return { defaultBranch: 'main', refs: { main: SHA }, tarballs: { [SHA]: tarball(entries) } };
}

function github(entries: TarEntry[], opts: { token?: string; rateLimited?: boolean } = {}) {
  const fake = fakeGithub(
    { 'anthropics/skills': repoWith(entries) },
    opts.rateLimited ? { rateLimited: true } : {},
  );
  const gh = new GithubClient(fake.fetch, {
    apiUrl: 'http://gh.test/',
    ...(opts.token === undefined ? {} : { token: opts.token }),
  });
  return { gh, requests: fake.requests };
}

const anthropics: TarEntry[] = [
  { path: 'README.md', content: '# skills' },
  { path: 'skills/mcp-builder/SKILL.md', content: skillMd('mcp-builder') },
  { path: 'skills/mcp-builder/reference/protocol.md', content: 'protocol' },
  { path: 'skills/mcp-builder/scripts/run.sh', content: '#!/bin/sh' },
  { path: 'skills/mcp-builder/scripts/link', type: '2', linkname: '../reference' },
  { path: 'skills/pdf/SKILL.md', content: skillMd('pdf') },
  { path: 'skills/pdf/forms.md', content: 'forms' },
];

const at = (p: string) => ({ repo: 'anthropics/skills', ref: null, path: p });
const answer = (res: Response | Error) =>
  new GithubClient(() => (res instanceof Error ? Promise.reject(res) : Promise.resolve(res)), {
    apiUrl: 'http://gh.test',
  });

describe('fetchSkill', () => {
  it('owner/repo --skill finds the directory by name, with subdirectories', async () => {
    const { gh, requests } = github(anthropics, { token: 'ghp_x' });
    const s = await fetchSkill(gh, parseSource('anthropics/skills'), 'mcp-builder', MAX);
    expect(s).toMatchObject({
      repo: 'anthropics/skills',
      ref: null,
      path: 'skills/mcp-builder',
      commit: SHA,
      name: 'mcp-builder',
      description: 'About mcp-builder',
      skipped: ['scripts/link'],
    });
    expect([...s.files.keys()].toSorted()).toEqual([
      'SKILL.md',
      'reference/protocol.md',
      'scripts/run.sh',
    ]);
    expect(requests.map((r) => new URL(r.url).pathname)).toEqual([
      '/repos/anthropics/skills',
      '/repos/anthropics/skills/commits/main',
      `/repos/anthropics/skills/tarball/${SHA}`,
    ]);
    expect(requests[0]?.headers.get('authorization')).toBe('Bearer ghp_x');
    expect(requests[1]?.headers.get('accept')).toBe('application/vnd.github.sha');
  });

  it('a URL with a path reads exactly that directory at the ref', async () => {
    const { gh, requests } = github(anthropics);
    const url = 'https://github.com/anthropics/skills/tree/main/skills/pdf';
    const s = await fetchSkill(gh, parseSource(url), null, MAX);
    expect(s).toMatchObject({ path: 'skills/pdf', ref: 'main', name: 'pdf' });
    expect([...s.files.keys()]).toEqual(['SKILL.md', 'forms.md']);
    expect(requests[0]?.headers.has('authorization')).toBe(false);
  });

  it('a repository URL without a path takes the root SKILL.md and every file', async () => {
    const { gh } = github([
      { path: 'SKILL.md', content: skillMd('root-skill') },
      { path: 'docs/a.md', content: 'a' },
    ]);
    const s = await fetchSkill(gh, parseSource('https://github.com/anthropics/skills'), null, MAX);
    expect(s).toMatchObject({ path: '', name: 'root-skill' });
    expect([...s.files.keys()]).toEqual(['SKILL.md', 'docs/a.md']);
  });

  it('a root skill found by name gets all files in a second pass', async () => {
    const { gh, requests } = github([
      { path: 'SKILL.md', content: skillMd('root-skill') },
      { path: 'docs/a.md', content: 'a' },
    ]);
    const s = await fetchSkill(gh, parseSource('anthropics/skills'), 'root-skill', MAX);
    expect(s.path).toBe('');
    expect([...s.files.keys()]).toEqual(['SKILL.md', 'docs/a.md']);
    expect(requests.filter((r) => r.url.includes('/tarball/'))).toHaveLength(2);
  });

  it('a directory named differently from the skill is read in a second pass', async () => {
    const { gh, requests } = github([
      { path: 'skills/fe/SKILL.md', content: skillMd('frontend-design') },
      { path: 'skills/fe/guide/colors.md', content: 'colors' },
      { path: 'skills/fe/LICENSE', content: 'MIT' },
    ]);
    const s = await fetchSkill(gh, parseSource('anthropics/skills'), 'frontend-design', MAX);
    expect(s.path).toBe('skills/fe');
    expect([...s.files.keys()]).toEqual(['SKILL.md', 'guide/colors.md', 'LICENSE']);
    expect(requests.filter((r) => r.url.includes('/tarball/'))).toHaveLength(2);
  });

  it('several names: one commit, one pass, and one more for all dirs named differently', async () => {
    const { gh, requests } = github([
      ...anthropics,
      { path: 'skills/fe/SKILL.md', content: skillMd('frontend-design') },
      { path: 'skills/fe/LICENSE', content: 'MIT' },
      { path: 'skills/ui/SKILL.md', content: skillMd('ui-kit') },
      { path: 'skills/ui/a.md', content: 'a' },
    ]);
    const names = ['pdf', 'frontend-design', 'nope', 'ui-kit', 'mcp-builder'];
    const got = await fetchSkills(gh, parseSource('anthropics/skills'), names, MAX);
    expect(
      got.map((s) => (s instanceof Error ? s.message : [s.path, s.commit, [...s.files.keys()]])),
    ).toEqual([
      ['skills/pdf', SHA, ['SKILL.md', 'forms.md']],
      ['skills/fe', SHA, ['SKILL.md', 'LICENSE']],
      'skill "nope" not found in anthropics/skills',
      ['skills/ui', SHA, ['SKILL.md', 'a.md']],
      ['skills/mcp-builder', SHA, ['SKILL.md', 'reference/protocol.md', 'scripts/run.sh']],
    ]);
    const kind = (k: string) => requests.filter((r) => r.url.includes(`/${k}/`));
    expect(kind('commits')).toHaveLength(1);
    expect(kind('tarball')).toHaveLength(2);
  });

  it('several names whose dirs match them need a single tarball pass', async () => {
    const { gh, requests } = github(anthropics);
    const got = await fetchSkills(
      gh,
      parseSource('anthropics/skills'),
      ['pdf', 'mcp-builder'],
      MAX,
    );
    expect(got.map((s) => !(s instanceof Error) && s.name)).toEqual(['pdf', 'mcp-builder']);
    expect(requests.filter((r) => r.url.includes('/tarball/'))).toHaveLength(1);
  });

  it('two directories with the same name are ambiguous; none is not found', async () => {
    const { gh } = github([
      { path: 'a/x/SKILL.md', content: skillMd('x') },
      { path: 'b/y/SKILL.md', content: skillMd('x') },
    ]);
    await expect(fetchSkill(gh, parseSource('anthropics/skills'), 'x', MAX)).rejects.toThrow(
      'skill "x" is ambiguous: a/x, b/y; pass a URL with the path',
    );
    await expect(fetchSkill(gh, parseSource('anthropics/skills'), 'zzz', MAX)).rejects.toThrow(
      'skill "zzz" not found in anthropics/skills',
    );
    await expect(fetchSkill(gh, parseSource('anthropics/skills'), null, MAX)).rejects.toThrow(
      UsageError,
    );
  });

  it('a name matching only a directory hints the skill it holds', async () => {
    const { gh } = github([
      {
        path: 'skills/react-best-practices/SKILL.md',
        content: skillMd('vercel-react-best-practices'),
      },
      { path: 'skills/pdf/SKILL.md', content: skillMd('pdf') },
    ]);
    const hint =
      'skill "react-best-practices" not found in anthropics/skills; directory ' +
      'skills/react-best-practices holds skill "vercel-react-best-practices"; ' +
      'pass --skill vercel-react-best-practices';
    const target = parseSource('anthropics/skills');
    await expect(fetchSkill(gh, target, 'react-best-practices', MAX)).rejects.toThrow(hint);
    const got = await fetchSkills(gh, target, ['pdf', 'react-best-practices'], MAX);
    expect(got.map((s) => (s instanceof Error ? s.message : s.name))).toEqual(['pdf', hint]);
  });

  it('several directories matching the name, ignoring case, are all listed', async () => {
    const { gh } = github([
      { path: 'b/Deploy/SKILL.md', content: skillMd('deploy-b') },
      { path: 'a/deploy/SKILL.md', content: skillMd('deploy-a') },
      { path: 'c/deploy/README.md', content: 'no skill' },
      { path: 'deploy-x/SKILL.md', content: skillMd('other') },
    ]);
    await expect(fetchSkill(gh, parseSource('anthropics/skills'), 'deploy', MAX)).rejects.toThrow(
      'skill "deploy" not found in anthropics/skills; directories a/deploy holds "deploy-a", ' +
        'b/Deploy holds "deploy-b"; pass --skill with one of these names',
    );
  });

  it('without a matching directory the message has no hint', async () => {
    const { gh } = github([
      { path: 'SKILL.md', content: skillMd('root') },
      { path: 'skills/pdf/SKILL.md', content: skillMd('pdf') },
      { path: 'skills/broken/SKILL.md', content: '# no frontmatter' },
    ]);
    const got = await fetchSkills(gh, parseSource('anthropics/skills'), ['nope', 'broken'], MAX);
    expect(got.map((s) => s instanceof Error && s.message)).toEqual([
      'skill "nope" not found in anthropics/skills',
      'skill "broken" not found in anthropics/skills',
    ]);
  });

  it('skips files whose path the registry would store differently', async () => {
    const long = 'x'.repeat(101);
    const { gh } = github([
      { path: 'skills/pdf/SKILL.md', content: skillMd('pdf') },
      { path: 'skills/pdf/ok/a.md', content: 'a' },
      { path: 'skills/pdf/win\\path.md', content: 'b' },
      { path: 'skills/pdf/./dot.md', content: 'c' },
      { path: 'skills/pdf/a//b.md', content: 'd' },
      { path: `skills/pdf/${long}`, content: 'e', long: 'pax' },
    ]);
    const s = await fetchSkill(gh, at('skills/pdf'), null, MAX);
    expect([...s.files.keys()]).toEqual(['SKILL.md', 'ok/a.md']);
    expect(s.skipped).toEqual(['win\\path.md', './dot.md', 'a//b.md', long]);
  });

  it('checks the registry limits with the file path', async () => {
    const { gh } = github([
      { path: 's/SKILL.md', content: skillMd('s') },
      { path: 's/huge.bin', content: new Uint8Array(1_048_577) },
    ]);
    await expect(fetchSkill(gh, parseSource('anthropics/skills'), 's', MAX)).rejects.toThrow(
      'huge.bin is 1048577 bytes; the registry allows at most 1048576',
    );
  });

  it('a directory without SKILL.md or frontmatter, or with another name, is an error', async () => {
    const { gh } = github([
      { path: 'empty/readme.md', content: 'x' },
      { path: 'bad/SKILL.md', content: '# no frontmatter' },
      { path: 'other/SKILL.md', content: skillMd('other') },
    ]);
    await expect(fetchSkill(gh, at('empty'), null, MAX)).rejects.toThrow(
      'no SKILL.md in anthropics/skills/empty',
    );
    await expect(fetchSkill(gh, at('bad'), null, MAX)).rejects.toThrow(/no frontmatter/);
    await expect(fetchSkill(gh, at('other'), 'pdf', MAX)).rejects.toThrow(/named "other"/);
  });

  it('404 and the rate limit are clear errors', async () => {
    const { gh } = github(anthropics);
    await expect(gh.resolveCommit('nobody/nothing', null)).rejects.toThrow(
      'repository or ref not found: nobody/nothing',
    );
    await expect(gh.resolveCommit('anthropics/skills', 'nope')).rejects.toThrow(
      'repository or ref not found: anthropics/skills@nope',
    );
    const limited = github(anthropics, { rateLimited: true }).gh;
    await expect(limited.resolveCommit('anthropics/skills', null)).rejects.toThrow(
      'GitHub rate limit; set GITHUB_TOKEN',
    );
  });

  it('other GitHub failures', async () => {
    await expect(
      answer(new Response('', { status: 401 })).resolveCommit('o/r', 'm'),
    ).rejects.toThrow('GitHub rejected GITHUB_TOKEN');
    await expect(
      answer(new Response('', { status: 500 })).resolveCommit('o/r', 'm'),
    ).rejects.toThrow('GitHub answered HTTP 500 for o/r@m');
    await expect(answer(new Response('not-a-sha')).resolveCommit('o/r', 'm')).rejects.toThrow(
      /unexpected GitHub answer/,
    );
    await expect(answer(Response.json({})).resolveCommit('o/r', null)).rejects.toThrow(
      /unexpected GitHub answer/,
    );
    await expect(answer(new Error('offline')).resolveCommit('o/r', 'm')).rejects.toThrow(
      'cannot reach GitHub: offline',
    );
    await expect(answer(new Response(null)).tarball('o/r', SHA)).rejects.toThrow(/empty tarball/);
  });
});

describe('parseFrontmatter', () => {
  it('reads name and description; anything else is null', () => {
    expect(parseFrontmatter('﻿---\r\nname: x\r\ndescription: "d: e"\r\n---\r\nbody')).toEqual({
      name: 'x',
      description: 'd: e',
    });
    expect(parseFrontmatter('# none')).toBeNull();
    expect(parseFrontmatter('---\nname: x\n---\n')).toBeNull();
    expect(parseFrontmatter('---\n- a\n---\n')).toBeNull();
    expect(parseFrontmatter('---\nname: [\n---\n')).toBeNull();
  });
});
