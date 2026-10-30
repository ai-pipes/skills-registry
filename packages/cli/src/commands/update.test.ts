import { createHash } from 'node:crypto';
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

const OLD = 'aaaaaaa0123456789abcdef0123456789abcdef0';
const NEW = 'bbbbbbb0123456789abcdef0123456789abcdef0';
const MD = '---\nname: pdf\ndescription: PDF tools\n---\n# pdf\n';

type Files = Record<string, string>;
const A: Files = { 'SKILL.md': MD, 'reference/old.md': 'old' };
const sha = (s: string) => createHash('sha256').update(s).digest('hex');

function setup(p: {
  versions: Record<number, Files>;
  synced?: number | null;
  status?: 'active' | 'archived';
  upstream: Files;
  putStatus?: number;
  syncedCommit?: string;
}) {
  const current = Math.max(...Object.keys(p.versions).map(Number));
  const synced = p.synced === undefined ? 1 : p.synced;
  const github = fakeGithub({
    'anthropics/skills': {
      defaultBranch: 'main',
      refs: { main: NEW },
      tarballs: {
        [NEW]: tarball(
          Object.entries(p.upstream).map(([k, v]) => ({ path: `skills/pdf/${k}`, content: v })),
        ),
      },
    },
  });
  const view = (n: number) => {
    const files = p.versions[n] ?? {};
    return skillView('pdf', {
      version: n,
      status: p.status ?? 'active',
      files: Object.entries(files).map(([path, c]) => ({
        path,
        size: c.length,
        binary: false,
        sha256: sha(c),
      })),
      skillMdSha256: sha(files['SKILL.md'] ?? ''),
      source:
        synced === null
          ? null
          : {
              host: 'github.com',
              repo: 'anthropics/skills',
              path: 'skills/pdf',
              ref: null,
              syncedVersion: synced,
            },
      sourceCommit: n === synced ? (p.syncedCommit ?? OLD) : null,
    });
  };
  const registry = recordingFetch((r: Recorded) => {
    const url = new URL(r.url);
    if (r.method === 'GET' && url.pathname === '/api/skills/pdf') {
      const v = url.searchParams.get('version');
      return json(200, view(v === null ? current : Number(v)));
    }
    if (r.method === 'GET' && url.pathname === '/api/skills/pdf/history') {
      return json(
        200,
        Object.keys(p.versions)
          .map(Number)
          .toReversed()
          .map((number) => ({
            number,
            authorId: 'u',
            authorLogin: number === 3 ? 'ann' : 'bob',
            message: null,
            createdAt: '2026-10-29T10:00:00.000Z',
            restoredFrom: null,
            sourceCommit: null,
          })),
      );
    }
    if (r.method === 'PUT' && url.pathname === '/api/skills/pdf') {
      if (p.putStatus === 409) {
        return json(409, { error: { code: 'version_conflict', message: 'stale' } });
      }
      return json(200, { slug: 'pdf', version: current + 1 });
    }
    return json(404, { error: { code: 'not_found', message: 'not found' } });
  });
  const env = fakeEnv({
    fetch: (input, init) => {
      const u = input instanceof Request ? input.url : input.toString();
      return u.startsWith('http://gh.test')
        ? github.fetch(input, init)
        : registry.fetch(input, init);
    },
    vars: {
      SKILLS_REGISTRY_URL: 'http://reg.test',
      SKILLS_REGISTRY_TOKEN: 'sk_t',
      GITHUB_API_URL: 'http://gh.test',
    },
  });
  const puts = () => registry.requests.filter((r) => r.method === 'PUT');
  const tarballs = () => github.requests.filter((r) => r.url.includes('/tarball/'));
  return { env, puts, tarballs };
}

const LABEL = 'anthropics/skills/skills/pdf@bbbbbbb';

describe('update', () => {
  it('the synced commit is up to date: registry edits are kept, nothing is downloaded', async () => {
    const versions = { 2: A, 3: { ...A, 'x.md': 'x' } };
    const { env, puts, tarballs } = setup({ versions, synced: 2, syncedCommit: NEW, upstream: A });
    expect(await runCli(['update', 'pdf'], env)).toBe(0);
    expect(env.stdout).toEqual([
      `pdf is up to date (${LABEL})`,
      '  registry changes since v2 are kept (v3)',
    ]);
    expect(env.stderr).toEqual([]);
    expect(tarballs()).toEqual([]);
    expect(puts()).toEqual([]);
    expect(await runCli(['update', 'pdf', '--dry-run'], env)).toBe(0);
    expect(tarballs()).toEqual([]);
    expect(puts()).toEqual([]);
  });

  it('the synced commit without registry edits is up to date without a download', async () => {
    const { env, puts, tarballs } = setup({ versions: { 1: A }, syncedCommit: NEW, upstream: A });
    expect(await runCli(['update', 'pdf'], env)).toBe(0);
    expect(env.stdout).toEqual([`pdf is up to date (${LABEL})`]);
    expect(tarballs()).toEqual([]);
    expect(puts()).toEqual([]);
  });

  it('a new commit with the same content is up to date', async () => {
    const { env, puts } = setup({ versions: { 1: A }, upstream: A });
    expect(await runCli(['update', 'pdf'], env)).toBe(0);
    expect(env.stdout).toEqual([`pdf is up to date (v1, ${LABEL})`]);
    expect(puts()).toEqual([]);
  });

  it('publishes a new upstream commit with all its files and no warning', async () => {
    const upstream = { ...A, 'reference/new.md': 'new', 'SKILL.md': `${MD}more\n` };
    const { env, puts } = setup({ versions: { 1: A, 2: A }, synced: 2, upstream });
    expect(await runCli(['update', 'pdf'], env)).toBe(0);
    const form = formOf(puts()[0]);
    expect(form.get('baseVersion')).toBe('2');
    expect(form.get('sourceCommit')).toBe(NEW);
    expect(form.get('keep')).toBe('[]');
    expect(form.get('message')).toBe(`update from ${LABEL}`);
    expect(env.stderr).toEqual([]);
    expect(env.stdout).toEqual([
      `updated pdf v2 → v3 from ${LABEL}`,
      '  + reference/new.md',
      '  ~ SKILL.md',
    ]);
  });

  it('warns about registry changes since the synced version, then publishes', async () => {
    const versions = { 2: A, 3: { ...A, 'x.md': 'x' }, 4: { ...A, 'SKILL.md': `${MD}local\n` } };
    const { env, puts } = setup({ versions, synced: 2, upstream: { ...A, 'n.md': 'n' } });
    expect(await runCli(['update', 'pdf'], env)).toBe(0);
    expect(env.stderr).toEqual([
      'warning: pdf has changes made in the registry since v2: v3 (ann), v4 (bob)',
      `  they will be overwritten by ${LABEL}`,
      '  changed files: SKILL.md',
      '  to restore: roll back to v4 in the UI',
    ]);
    expect(puts()).toHaveLength(1);
  });

  it('a rollback to the synced content is not a conflict', async () => {
    const { env, puts } = setup({
      versions: { 2: A, 3: A },
      synced: 2,
      upstream: { ...A, 'n.md': 'n' },
    });
    expect(await runCli(['update', 'pdf'], env)).toBe(0);
    expect(env.stderr).toEqual([]);
    expect(puts()).toHaveLength(1);
  });

  it('a file removed upstream disappears from the new version', async () => {
    const { env, puts } = setup({ versions: { 1: A }, upstream: { 'SKILL.md': MD } });
    expect(await runCli(['update', 'pdf'], env)).toBe(0);
    expect([...formOf(puts()[0]).keys()]).not.toContain('reference/old.md');
    expect(formOf(puts()[0]).get('SKILL.md')).not.toBeNull();
    expect(env.stdout.at(-1)).toBe('  - reference/old.md');
  });

  it('a skill that was not imported cannot be updated', async () => {
    const { env } = setup({ versions: { 1: A }, synced: null, upstream: A });
    expect(await runCli(['update', 'pdf'], env)).toBe(1);
    expect(env.stderr).toEqual(['error: skill "pdf" was not imported; nothing to update from']);
  });

  it('an archived skill and a missing skill fail', async () => {
    const archived = setup({ versions: { 1: A }, status: 'archived', upstream: A });
    expect(await runCli(['update', 'pdf'], archived.env)).toBe(1);
    expect(archived.env.stderr).toEqual(['error: skill "pdf" is archived']);
    const missing = setup({ versions: { 1: A }, upstream: A });
    expect(await runCli(['update', 'nope'], missing.env)).toBe(1);
    expect(missing.env.stderr).toEqual(['error: skill "nope" not found']);
  });

  it('a source from another repository is a mismatch and publishes nothing', async () => {
    const { env, puts } = setup({ versions: { 1: A }, upstream: { ...A, 'n.md': 'n' } });
    expect(await runCli(['update', 'pdf', 'other/repo'], env)).toBe(1);
    expect(env.stderr).toEqual([
      'error: source mismatch: skill comes from anthropics/skills/skills/pdf, not other/repo',
    ]);
    expect(puts()).toEqual([]);
    const ok = setup({ versions: { 1: A }, upstream: A });
    const url = 'https://github.com/anthropics/skills/tree/main/skills/pdf';
    expect(await runCli(['update', 'pdf', url], ok.env)).toBe(1);
    expect(await runCli(['update', 'pdf', 'anthropics/skills'], ok.env)).toBe(0);
  });

  it('a skill renamed upstream is not supported', async () => {
    const md = MD.replace('name: pdf', 'name: pdf2');
    const { env, puts } = setup({ versions: { 1: A }, upstream: { 'SKILL.md': md } });
    expect(await runCli(['update', 'pdf'], env)).toBe(1);
    expect(env.stderr).toEqual([
      'error: upstream renamed the skill to "pdf2"; update is not supported',
    ]);
    expect(puts()).toEqual([]);
  });

  it('a concurrent save asks to run update again', async () => {
    const { env } = setup({ versions: { 1: A }, upstream: { 'SKILL.md': MD }, putStatus: 409 });
    expect(await runCli(['update', 'pdf'], env)).toBe(1);
    expect(env.stderr).toEqual(['error: skill "pdf" changed while updating; run update again']);
  });

  it('--dry-run prints the warning and the plan without publishing', async () => {
    const versions = { 1: A, 2: { ...A, 'x.md': 'x' } };
    const { env, puts } = setup({ versions, synced: 1, upstream: { 'SKILL.md': MD } });
    expect(await runCli(['update', 'pdf', '--dry-run'], env)).toBe(0);
    expect(puts()).toEqual([]);
    expect(env.stderr[0]).toBe('warning: pdf has changes made in the registry since v1: v2 (bob)');
    expect(env.stdout).toEqual([
      `would update pdf v2 → v3 from ${LABEL}`,
      '  - reference/old.md',
      '  - x.md',
    ]);
  });
});
