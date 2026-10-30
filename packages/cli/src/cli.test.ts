import { describe, expect, it } from 'vite-plus/test';
import { fakeEnv } from '../test/fake-env.ts';
import { json, recordingFetch, skillSummary } from '../test/registry-fixtures.ts';
import { runCli } from './cli.ts';
import { loadConnection, saveConnection } from './config.ts';
import { MAX_FILE_BYTES, MAX_FILES, MAX_SKILL_BYTES, tarLimits } from './limits.ts';

const TOKEN = 'sk_very_secret_token';
const output = (env: { stdout: string[]; stderr: string[] }) =>
  [...env.stdout, ...env.stderr].join('\n');

describe('runCli', () => {
  it('prints usage with --help and exits 0', async () => {
    const env = fakeEnv();
    expect(await runCli(['--help'], env)).toBe(0);
    expect(env.stdout.join('\n')).toMatch(/^usage: skills-registry/);
  });

  it('an unknown command is a usage error: 2 and usage on stderr', async () => {
    const env = fakeEnv();
    expect(await runCli(['frobnicate'], env)).toBe(2);
    expect(env.stderr[0]).toBe('error: unknown command "frobnicate"');
    expect(env.stderr.join('\n')).toContain('usage: skills-registry');
    expect(await runCli(['list', '--bogus'], env)).toBe(2);
  });

  it('a failed operation exits 1', async () => {
    const env = fakeEnv({
      vars: { SKILLS_REGISTRY_URL: 'https://r.example', SKILLS_REGISTRY_TOKEN: TOKEN },
    });
    expect(await runCli(['install', 'pdf'], env)).toBe(1);
    expect(env.stderr.join('\n')).toContain('cannot reach https://r.example');
  });

  it('login reads the token, checks it with /api/auth/me and saves it', async () => {
    const { fetch, requests } = recordingFetch(() => json(200, { login: 'ann', role: 'member' }));
    const prompts: string[] = [];
    const env = fakeEnv({
      fetch,
      readSecret: (prompt) => {
        prompts.push(prompt);
        return Promise.resolve(`${TOKEN}\n`);
      },
    });
    expect(await runCli(['login', 'https://skills.example/'], env)).toBe(0);
    expect(prompts).toEqual(['Token: ']);
    expect(requests[0]?.url).toBe('https://skills.example/api/auth/me');
    expect(requests[0]?.headers.get('authorization')).toBe(`Bearer ${TOKEN}`);
    expect(await loadConnection(env)).toEqual({ url: 'https://skills.example', token: TOKEN });
    expect(env.stdout).toEqual(['logged in to https://skills.example as ann']);
    expect(output(env)).not.toContain(TOKEN);
  });

  it('login with a rejected token saves nothing and exits 1', async () => {
    const { fetch } = recordingFetch(() =>
      json(401, { error: { code: 'unauthorized', message: 'invalid token' } }),
    );
    const env = fakeEnv({ fetch, readSecret: () => Promise.resolve(TOKEN) });
    expect(await runCli(['login', 'https://skills.example'], env)).toBe(1);
    expect(await loadConnection(env)).toBeNull();
    expect(env.stderr).toEqual(['error: invalid token']);
    expect(output(env)).not.toContain(TOKEN);
  });

  it('login rejects a bad URL and an empty token', async () => {
    const env = fakeEnv({ readSecret: () => Promise.resolve('  \n') });
    expect(await runCli(['login', 'ftp://x'], env)).toBe(2);
    expect(await runCli(['login', 'not a url'], env)).toBe(2);
    expect(await runCli(['login', 'https://skills.example'], env)).toBe(2);
    expect(await runCli(['login'], env)).toBe(2);
  });

  it('logout removes the saved connection', async () => {
    const env = fakeEnv();
    await saveConnection(env, { url: 'https://skills.example', token: TOKEN });
    expect(await runCli(['logout'], env)).toBe(0);
    expect(await runCli(['logout'], env)).toBe(0);
    expect(env.stdout).toEqual(['logged out', 'not logged in']);
    expect(await loadConnection(env)).toBeNull();
  });

  it('list --folder prints slug, version, folder and description', async () => {
    const { fetch, requests } = recordingFetch(() =>
      json(200, [skillSummary('pdf', { version: 3 }), skillSummary('brand')]),
    );
    const env = fakeEnv({ fetch });
    await saveConnection(env, { url: 'https://skills.example', token: TOKEN });
    expect(await runCli(['list', '--folder', 'design'], env)).toBe(0);
    expect(requests[0]?.url).toBe('https://skills.example/api/skills?folder=design');
    expect(env.stdout).toEqual(['pdf\tv3\tdesign\tAbout pdf', 'brand\tv1\tdesign\tAbout brand']);
  });

  it('list escapes control characters in server strings', async () => {
    const { fetch } = recordingFetch(() =>
      json(200, [skillSummary('pdf', { description: 'evil \u001b[31mred\nline' })]),
    );
    const env = fakeEnv({
      fetch,
      vars: { SKILLS_REGISTRY_URL: 'https://ci.example', SKILLS_REGISTRY_TOKEN: TOKEN },
    });
    expect(await runCli(['list'], env)).toBe(0);
    expect(env.stdout).toEqual(['pdf\tv1\tdesign\tevil ?[31mred?line']);
  });

  it('list without a login is a usage error', async () => {
    const env = fakeEnv();
    expect(await runCli(['list'], env)).toBe(2);
    expect(env.stderr[0]).toBe('error: not logged in: run skills-registry login <url>');
  });

  it('search sends the query; without one it is a usage error', async () => {
    const { fetch, requests } = recordingFetch(() => json(200, [skillSummary('pdf')]));
    const env = fakeEnv({
      fetch,
      vars: { SKILLS_REGISTRY_URL: 'https://ci.example', SKILLS_REGISTRY_TOKEN: TOKEN },
    });
    expect(await runCli(['search', 'pdf', 'forms', '--folder', 'design'], env)).toBe(0);
    expect(requests[0]?.url).toBe('https://ci.example/api/skills?folder=design&q=pdf+forms');
    expect(env.stdout).toEqual(['pdf\tv1\tdesign\tAbout pdf']);
    expect(await runCli(['search'], env)).toBe(2);
    expect(await runCli(['search', ' '], env)).toBe(2);
  });
});

describe('limits', () => {
  it('match the registry limits', () => {
    expect([MAX_FILES, MAX_FILE_BYTES, MAX_SKILL_BYTES]).toEqual([500, 1_048_576, 10_485_760]);
  });

  it('tarball caps default to 200 MiB / 1 GiB and honour the env overrides', () => {
    expect(tarLimits({})).toEqual({ compressedBytes: 209_715_200, unpackedBytes: 1_073_741_824 });
    expect(
      tarLimits({
        SKILLS_REGISTRY_MAX_TARBALL_BYTES: '1000',
        SKILLS_REGISTRY_MAX_UNPACKED_BYTES: '2000',
      }),
    ).toEqual({ compressedBytes: 1000, unpackedBytes: 2000 });
    expect(() => tarLimits({ SKILLS_REGISTRY_MAX_TARBALL_BYTES: '-1' })).toThrow(
      /SKILLS_REGISTRY_MAX_TARBALL_BYTES must be a positive integer/,
    );
    expect(() => tarLimits({ SKILLS_REGISTRY_MAX_TARBALL_BYTES: '0' })).toThrow();
    expect(() => tarLimits({ SKILLS_REGISTRY_MAX_UNPACKED_BYTES: '1e9' })).toThrow(
      /SKILLS_REGISTRY_MAX_UNPACKED_BYTES must be a positive integer/,
    );
  });
});
