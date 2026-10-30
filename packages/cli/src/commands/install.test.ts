import { createHash } from 'node:crypto';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vite-plus/test';
import { fakeEnv } from '../../test/fake-env.ts';
import { json, recordingFetch, skillView } from '../../test/registry-fixtures.ts';
import { runCli } from '../cli.ts';

const SERVER = 'https://r.example';
const sha = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');
const enc = (s: string) => new TextEncoder().encode(s);

/** A fake registry: `versions[n]` are the files of version n of skill `x` (latest = last). */
function registry(versions: Record<number, Record<string, Uint8Array>>) {
  const latest = Math.max(...Object.keys(versions).map(Number));
  return recordingFetch((r) => {
    const url = new URL(r.url);
    const v = Number(url.searchParams.get('version') ?? latest);
    const files = versions[v];
    const m = /^\/api\/skills\/x(?:\/files\/(.+))?$/.exec(url.pathname);
    if (!files || !m) return json(404, { error: { code: 'not_found', message: 'no such skill' } });
    if (m[1] === undefined) {
      return json(
        200,
        // Like the server: SKILL.md is not in `files`, only its hash in `skillMdSha256`.
        skillView('x', {
          version: v,
          files: Object.entries(files)
            .filter(([path]) => path !== 'SKILL.md')
            .map(([path, b]) => ({ path, size: b.length, binary: false, sha256: sha(b) })),
          skillMdSha256: sha(files['SKILL.md'] ?? new Uint8Array()),
        }),
      );
    }
    const b = files[decodeURIComponent(m[1])];
    return b
      ? new Response(new Uint8Array(b))
      : json(404, { error: { code: 'not_found', message: 'no' } });
  });
}

const v1 = {
  'SKILL.md': enc('# x v1'),
  'scripts/run.sh': enc('echo'),
  'img/a.bin': new Uint8Array([0, 255]),
};
const v2 = { 'SKILL.md': enc('# x v2') };

function setup(versions: Record<number, Record<string, Uint8Array>> = { 1: v1 }) {
  const reg = registry(versions);
  const env = fakeEnv({
    fetch: reg.fetch,
    vars: { SKILLS_REGISTRY_URL: SERVER, SKILLS_REGISTRY_TOKEN: 'sk_t' },
  });
  return { env, requests: reg.requests };
}

const canonical = (root: string) => join(root, '.agents/skills/x');
const marker = (dir: string) =>
  JSON.parse(readFileSync(join(dir, '.skills-registry.json'), 'utf8'));

describe('install', () => {
  it('downloads files in parallel, at most 8 at once', async () => {
    const files: Record<string, Uint8Array> = { 'SKILL.md': enc('# x') };
    for (let i = 0; i < 20; i++) files[`f${i}.txt`] = enc(`file ${i}`);
    const reg = registry({ 1: files });
    let running = 0;
    let peak = 0;
    const env = fakeEnv({
      fetch: async (input, init) => {
        const isFile = String(input instanceof Request ? input.url : input).includes('/files/');
        if (!isFile) return reg.fetch(input, init);
        running++;
        peak = Math.max(peak, running);
        await new Promise((r) => setTimeout(r, 2));
        running--;
        return reg.fetch(input, init);
      },
      vars: { SKILLS_REGISTRY_URL: SERVER, SKILLS_REGISTRY_TOKEN: 'sk_t' },
    });
    expect(await runCli(['install', 'x', '--dir', 'out'], env)).toBe(0);
    expect(peak).toBe(8);
    expect(readFileSync(join(env.cwd, 'out/x/f19.txt'), 'utf8')).toBe('file 19');
  });

  it('installs into the project with a relative symlink for claude-code and a marker', async () => {
    const { env } = setup();
    expect(await runCli(['install', 'x', '-a', 'claude-code'], env)).toBe(0);
    const dir = canonical(env.cwd);
    expect(readFileSync(join(dir, 'scripts/run.sh'), 'utf8')).toBe('echo');
    expect(readFileSync(join(dir, 'img/a.bin'))).toEqual(Buffer.from([0, 255]));
    expect(readlinkSync(join(env.cwd, '.claude/skills/x'))).toBe('../../.agents/skills/x');
    expect(marker(dir)).toEqual({
      server: SERVER,
      slug: 'x',
      version: 1,
      files: Object.fromEntries(Object.entries(v1).map(([p, b]) => [p, sha(b)])),
    });
    expect(env.stdout).toEqual([
      `installed x v1 → ${dir}`,
      `  linked claude-code: ${join(env.cwd, '.claude/skills/x')}`,
    ]);
  });

  it('-g installs under home; detected cursor links only globally', async () => {
    const { env } = setup();
    mkdirSync(join(env.home, '.cursor'));
    expect(await runCli(['install', 'x'], env)).toBe(0);
    expect(existsSync(canonical(env.cwd))).toBe(true);
    expect(existsSync(join(env.cwd, '.cursor'))).toBe(false);
    expect(await runCli(['install', 'x', '-g'], env)).toBe(0);
    expect(existsSync(canonical(env.home))).toBe(true);
    expect(readlinkSync(join(env.home, '.cursor/skills/x'))).toBe('../../.agents/skills/x');
  });

  it('--dir installs only into <dir>/<slug>', async () => {
    const { env } = setup();
    expect(await runCli(['install', 'x', '--dir', 'out', '-a', 'claude-code'], env)).toBe(0);
    expect(existsSync(join(env.cwd, 'out/x/SKILL.md'))).toBe(true);
    expect(existsSync(join(env.cwd, '.agents'))).toBe(false);
    expect(existsSync(join(env.cwd, '.claude'))).toBe(false);
  });

  it('same version → already installed; a new version updates; x@1 asks for version 1', async () => {
    const { env, requests } = setup({ 1: v1, 2: v2 });
    expect(await runCli(['install', 'x@1', '-a', 'claude-code'], env)).toBe(0);
    expect(requests[0]?.url).toBe(`${SERVER}/api/skills/x?version=1`);
    expect(await runCli(['install', 'x@1', '-a', 'claude-code'], env)).toBe(0);
    expect(env.stdout.at(-1)).toBe('x v1 is already installed');
    expect(await runCli(['install', 'x', '-a', 'claude-code'], env)).toBe(0);
    expect(marker(canonical(env.cwd)).version).toBe(2);
    expect(existsSync(join(canonical(env.cwd), 'scripts'))).toBe(false);
    expect(readFileSync(join(env.cwd, '.claude/skills/x/SKILL.md'), 'utf8')).toBe('# x v2');
  });

  it('a hand-modified file or a directory without a marker is a conflict; --force overwrites', async () => {
    const { env } = setup({ 1: v1, 2: v2 });
    expect(await runCli(['install', 'x@1'], env)).toBe(0);
    const file = join(canonical(env.cwd), 'SKILL.md');
    writeFileSync(file, 'mine');
    expect(await runCli(['install', 'x'], env)).toBe(1);
    expect(env.stderr).toEqual([
      `conflict: ${canonical(env.cwd)} was not installed by skills-registry or was modified; use --force`,
    ]);
    expect(readFileSync(file, 'utf8')).toBe('mine');
    expect(await runCli(['install', 'x', '--force'], env)).toBe(0);
    expect(readFileSync(file, 'utf8')).toBe('# x v2');

    const other = setup();
    mkdirSync(canonical(other.env.cwd), { recursive: true });
    writeFileSync(join(canonical(other.env.cwd), 'SKILL.md'), 'foreign');
    expect(await runCli(['install', 'x'], other.env)).toBe(1);
    expect(readFileSync(join(canonical(other.env.cwd), 'SKILL.md'), 'utf8')).toBe('foreign');
  });

  it('an agent path pointing elsewhere is a conflict; --force replaces it', async () => {
    const { env } = setup();
    mkdirSync(join(env.cwd, '.claude/skills'), { recursive: true });
    symlinkSync('/somewhere', join(env.cwd, '.claude/skills/x'));
    expect(await runCli(['install', 'x', '-a', 'claude-code'], env)).toBe(1);
    expect(existsSync(canonical(env.cwd))).toBe(false);
    expect(await runCli(['install', 'x', '-a', 'claude-code', '--force'], env)).toBe(0);
    expect(readlinkSync(join(env.cwd, '.claude/skills/x'))).toBe('../../.agents/skills/x');
  });

  it('a file path escaping the skill directory fails and nothing is written', async () => {
    const { env } = setup({ 1: { 'SKILL.md': enc('# x'), '../evil': enc('!') } });
    expect(await runCli(['install', 'x'], env)).toBe(1);
    expect(env.stderr.join('\n')).toContain('unsafe file path "../evil"');
    expect(existsSync(join(env.cwd, '.agents'))).toBe(false);
    expect(existsSync(join(env.cwd, '.agents/skills/evil'))).toBe(false);
  });

  it('a missing skill fails; a bad slug or version is a usage error', async () => {
    const { env } = setup();
    expect(await runCli(['install', 'x@7'], env)).toBe(1);
    expect(env.stderr).toEqual(['error: x v7 not found']);
    expect(await runCli(['install', '../x'], env)).toBe(2);
    expect(await runCli(['install', 'x@0'], env)).toBe(2);
    expect(await runCli(['install', 'x', '-a', 'vim'], env)).toBe(2);
  });

  it('--copy makes an independent copy instead of a symlink', async () => {
    const { env } = setup();
    expect(await runCli(['install', 'x', '-a', 'claude-code', '--copy'], env)).toBe(0);
    const copy = join(env.cwd, '.claude/skills/x');
    expect(lstatSync(copy).isDirectory()).toBe(true);
    expect(marker(copy).slug).toBe('x');
    expect(env.stdout.at(-1)).toBe(`  copied claude-code: ${copy}`);
  });
});

describe('uninstall', () => {
  it('removes our links and the canonical copy; skips foreign directories', async () => {
    const { env } = setup();
    expect(await runCli(['install', 'x', '-a', 'claude-code', '-a', 'roo', '--copy'], env)).toBe(0);
    mkdirSync(join(env.cwd, '.windsurf/skills/x'), { recursive: true });
    env.stdout.length = 0;
    expect(await runCli(['uninstall', 'x'], env)).toBe(1);
    expect(existsSync(canonical(env.cwd))).toBe(false);
    expect(existsSync(join(env.cwd, '.claude/skills/x'))).toBe(false);
    expect(existsSync(join(env.cwd, '.roo/skills/x'))).toBe(false);
    expect(existsSync(join(env.cwd, '.windsurf/skills/x'))).toBe(true);
    expect(env.stdout).toEqual([
      `removed ${join(env.cwd, '.claude/skills/x')}`,
      `removed ${join(env.cwd, '.roo/skills/x')}`,
      `removed ${canonical(env.cwd)}`,
    ]);
    expect(env.stderr).toEqual([
      `skipped ${join(env.cwd, '.windsurf/skills/x')}: not installed by skills-registry`,
    ]);
  });

  it('a link elsewhere and a canonical copy without a marker are skipped', async () => {
    const env = fakeEnv();
    mkdirSync(join(env.cwd, '.claude/skills'), { recursive: true });
    symlinkSync('/somewhere', join(env.cwd, '.claude/skills/x'));
    mkdirSync(canonical(env.cwd), { recursive: true });
    expect(await runCli(['uninstall', 'x', '-a', 'claude-code'], env)).toBe(1);
    expect(existsSync(canonical(env.cwd))).toBe(true);
    expect(lstatSync(join(env.cwd, '.claude/skills/x')).isSymbolicLink()).toBe(true);
    expect(env.stderr).toHaveLength(2);
  });

  it('nothing installed: says so and exits 0', async () => {
    const env = fakeEnv();
    expect(await runCli(['uninstall', 'x', '--dir', 'out'], env)).toBe(0);
    expect(env.stdout).toEqual(['x is not installed']);
  });
});
