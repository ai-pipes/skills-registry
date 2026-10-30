import { createHash } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vite-plus/test';
import { fakeEnv } from '../../test/fake-env.ts';
import { json, recordingFetch, skillView } from '../../test/registry-fixtures.ts';
import { runCli } from '../cli.ts';
import { linkOrCopy } from './write.ts';

// `symlink` is replaced by a spy that calls the real one unless a test makes it fail.
vi.mock('node:fs/promises', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:fs/promises')>();
  return { ...real, symlink: vi.fn(real.symlink) };
});
const symlinkSpy = vi.mocked(symlink);

const fail = (code: string) => {
  symlinkSpy.mockImplementation(() =>
    Promise.reject(Object.assign(new Error(`${code}: symlink`), { code })),
  );
};

// Back to the real `symlink` (the implementation given to `vi.fn`) and no recorded calls.
afterEach(() => symlinkSpy.mockReset());

function skill(env: ReturnType<typeof fakeEnv>) {
  const canonical = join(env.cwd, '.agents/skills/x');
  mkdirSync(canonical, { recursive: true });
  writeFileSync(join(canonical, 'SKILL.md'), '# x');
  return canonical;
}

describe('linkOrCopy when a symlink cannot be made', () => {
  it.each(['EPERM', 'EACCES'])('%s → an independent copy', async (code) => {
    const env = fakeEnv();
    const canonical = skill(env);
    fail(code);
    const link = join(env.cwd, '.claude/skills/x');
    expect(await linkOrCopy(canonical, link, { copy: false, platform: 'linux' })).toBe('copy');
    expect(symlinkSpy).toHaveBeenCalledOnce();
    expect(lstatSync(link).isDirectory()).toBe(true);
    expect(readFileSync(join(link, 'SKILL.md'), 'utf8')).toBe('# x');
  });

  it.each(['EEXIST', 'ENOENT'])('%s is rethrown, nothing is copied', async (code) => {
    const env = fakeEnv();
    const canonical = skill(env);
    fail(code);
    const link = join(env.cwd, '.claude/skills/x');
    await expect(linkOrCopy(canonical, link, { copy: false, platform: 'linux' })).rejects.toThrow(
      code,
    );
    expect(existsSync(link)).toBe(false);
  });

  it('win32 makes a junction to the absolute canonical path', async () => {
    const env = fakeEnv();
    const canonical = skill(env);
    symlinkSpy.mockResolvedValue(undefined);
    const link = join(env.cwd, '.claude/skills/x');
    expect(await linkOrCopy(canonical, link, { copy: false, platform: 'win32' })).toBe('link');
    expect(symlinkSpy).toHaveBeenCalledWith(canonical, link, 'junction');
  });

  it('linux makes a relative dir symlink', async () => {
    const env = fakeEnv();
    const canonical = skill(env);
    symlinkSpy.mockResolvedValue(undefined);
    const link = join(env.cwd, '.claude/skills/x');
    await linkOrCopy(canonical, link, { copy: false, platform: 'linux' });
    expect(symlinkSpy).toHaveBeenCalledWith('../../.agents/skills/x', link, 'dir');
  });
});

const sha = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');
const md = new TextEncoder().encode('# x v1');

/** A registry with skill `x` v1 (only SKILL.md) and an env pointing at it. */
function setup() {
  const reg = recordingFetch((r) => {
    const path = new URL(r.url).pathname;
    if (path === '/api/skills/x') {
      return json(200, skillView('x', { version: 1, files: [], skillMdSha256: sha(md) }));
    }
    if (path === '/api/skills/x/files/SKILL.md') return new Response(new Uint8Array(md));
    return json(404, { error: { code: 'not_found', message: 'no' } });
  });
  return fakeEnv({
    fetch: reg.fetch,
    vars: { SKILLS_REGISTRY_URL: 'https://r.example', SKILLS_REGISTRY_TOKEN: 'sk_t' },
  });
}

describe('install when a symlink cannot be made', () => {
  it.each(['EPERM', 'EACCES'])('%s → copied with a warning', async (code) => {
    const env = setup();
    fail(code);
    expect(await runCli(['install', 'x', '-a', 'claude-code'], env)).toBe(0);
    const path = join(env.cwd, '.claude/skills/x');
    expect(lstatSync(path).isDirectory()).toBe(true);
    expect(readFileSync(join(path, 'SKILL.md'), 'utf8')).toBe('# x v1');
    expect(env.stderr).toEqual([`warning: cannot create a symlink at ${path}; copied instead`]);
    expect(env.stdout.at(-1)).toBe(`  copied claude-code: ${path}`);
  });

  it('another error fails the install and is reported', async () => {
    const env = setup();
    fail('EEXIST');
    expect(await runCli(['install', 'x', '-a', 'claude-code'], env)).toBe(1);
    expect(env.stderr).toEqual(['error: x: EEXIST: symlink']);
    expect(existsSync(join(env.cwd, '.claude/skills/x'))).toBe(false);
  });
});
