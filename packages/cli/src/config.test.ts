import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vite-plus/test';
import { fakeEnv } from '../test/fake-env.ts';
import { UsageError } from './args.ts';
import { deleteConnection, loadConnection, requireConnection, saveConnection } from './config.ts';

const conn = { url: 'https://skills.example', token: 'sk_secret' };
const mode = async (path: string) => (await stat(path)).mode & 0o777;

describe('config', () => {
  it('saves under ~/.config with a 0600 file in a 0700 directory and loads it back', async () => {
    const env = fakeEnv();
    await saveConnection(env, conn);
    const dir = join(env.home, '.config', 'skills-registry');
    expect(await mode(dir)).toBe(0o700);
    expect(await mode(join(dir, 'config.json'))).toBe(0o600);
    expect(await loadConnection(env)).toEqual(conn);
  });

  it('honours XDG_CONFIG_HOME and tightens an existing directory', async () => {
    const env = fakeEnv();
    const xdg = join(env.home, 'xdg');
    env.vars.XDG_CONFIG_HOME = xdg;
    await mkdir(join(xdg, 'skills-registry'), { recursive: true, mode: 0o755 });
    await saveConnection(env, conn);
    expect(await mode(join(xdg, 'skills-registry'))).toBe(0o700);
    expect(JSON.parse(await readFile(join(xdg, 'skills-registry', 'config.json'), 'utf8'))).toEqual(
      conn,
    );
  });

  it('prefers SKILLS_REGISTRY_URL and SKILLS_REGISTRY_TOKEN over the file', async () => {
    const env = fakeEnv();
    await saveConnection(env, conn);
    env.vars.SKILLS_REGISTRY_URL = 'https://ci.example';
    env.vars.SKILLS_REGISTRY_TOKEN = 'sk_ci';
    expect(await loadConnection(env)).toEqual({ url: 'https://ci.example', token: 'sk_ci' });
  });

  it.each([
    ['SKILLS_REGISTRY_URL', 'https://ci.example'],
    ['SKILLS_REGISTRY_TOKEN', 'sk_ci'],
  ])('only %s set is a usage error, not a fallback to the file', async (name, value) => {
    const env = fakeEnv();
    await saveConnection(env, conn);
    env.vars[name] = value;
    await expect(loadConnection(env)).rejects.toBeInstanceOf(UsageError);
    await expect(loadConnection(env)).rejects.toThrow(
      /SKILLS_REGISTRY_URL and SKILLS_REGISTRY_TOKEN/,
    );
  });

  it('has no connection without a file; requireConnection is a usage error', async () => {
    const env = fakeEnv();
    expect(await loadConnection(env)).toBeNull();
    await expect(requireConnection(env)).rejects.toBeInstanceOf(UsageError);
  });

  it('rejects a malformed file', async () => {
    const env = fakeEnv();
    const dir = join(env.home, '.config', 'skills-registry');
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'config.json'), '{"url":1}');
    await expect(loadConnection(env)).rejects.toThrow(/invalid config file/);
  });

  it('deleteConnection reports whether there was a file', async () => {
    const env = fakeEnv();
    expect(await deleteConnection(env)).toBe(false);
    await saveConnection(env, conn);
    expect(await deleteConnection(env)).toBe(true);
    expect(await loadConnection(env)).toBeNull();
  });
});
