import { mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vite-plus/test';
import { fakeEnv } from '../../test/fake-env.ts';
import { sha256 } from '../manifest.ts';
import {
  MANIFEST,
  MCP_SERVER_RE,
  agentsDir,
  inspectSubagent,
  readInstalled,
  writeInstalled,
  writeSubagentFile,
} from './installed.ts';

const entry = (text: string, over = {}) => ({
  server: 'https://s.example',
  version: 2,
  sha256: sha256(new TextEncoder().encode(text)),
  mcpServer: 'skills',
  tools: null,
  ...over,
});

describe('agentsDir', () => {
  it('is under cwd or home', () => {
    const env = fakeEnv();
    expect(agentsDir(env, false)).toBe(join(env.cwd, '.claude', 'agents'));
    expect(agentsDir(env, true)).toBe(join(env.home, '.claude', 'agents'));
  });
});

describe('MCP_SERVER_RE', () => {
  it('accepts names and rejects the rest', () => {
    expect(MCP_SERVER_RE.test('my_server-1')).toBe(true);
    expect(MCP_SERVER_RE.test('a b')).toBe(false);
    expect(MCP_SERVER_RE.test('')).toBe(false);
  });
});

describe('manifest', () => {
  it('reads empty when missing or invalid, round-trips otherwise', async () => {
    const dir = join(fakeEnv().cwd, 'agents');
    expect(await readInstalled(dir)).toEqual({ subagents: {} });
    mkdirSync(dir);
    writeFileSync(join(dir, MANIFEST), '{nope');
    expect(await readInstalled(dir)).toEqual({ subagents: {} });
    writeFileSync(join(dir, MANIFEST), JSON.stringify({ subagents: { a: { version: 'x' } } }));
    expect(await readInstalled(dir)).toEqual({ subagents: {} });
    const m = { subagents: { a: entry('t', { tools: ['Read'] }) } };
    await writeInstalled(dir, m);
    expect(await readInstalled(dir)).toEqual(m);
    expect(readdirSync(dir)).toEqual([MANIFEST]);
  });

  it('creates the directory on write', async () => {
    const dir = join(fakeEnv().cwd, 'x', 'agents');
    await writeInstalled(dir, { subagents: {} });
    expect(await readInstalled(dir)).toEqual({ subagents: {} });
  });
});

describe('writeSubagentFile', () => {
  it('creates the directory, writes atomically and checks the slug', async () => {
    const dir = join(fakeEnv().cwd, 'a', 'agents');
    await writeSubagentFile(dir, 'devops', 'hello');
    expect(await readFile(join(dir, 'devops.md'), 'utf8')).toBe('hello');
    expect(readdirSync(dir)).toEqual(['devops.md']);
    await expect(writeSubagentFile(dir, '../evil', 'x')).rejects.toThrow(/invalid subagent slug/);
  });
});

const setup = (text: string, e: ReturnType<typeof entry> | null) => {
  const dir = join(fakeEnv().cwd, 'agents');
  mkdirSync(dir);
  writeFileSync(join(dir, 'devops.md'), text);
  return { dir, m: { subagents: e === null ? {} : { devops: e } } };
};

describe('inspectSubagent', () => {
  const server = 'https://s.example';

  it('absent when there is no file', async () => {
    const dir = join(fakeEnv().cwd, 'agents');
    expect(await inspectSubagent(dir, 'devops', server, { subagents: {} })).toBe('absent');
  });

  it('returns the entry when ours', async () => {
    const e = entry('body');
    const { dir, m } = setup('body', e);
    expect(await inspectSubagent(dir, 'devops', server, m)).toEqual(e);
  });

  it('foreign when edited, unrecorded or from another server', async () => {
    const e = entry('body');
    const edited = setup('body edited', e);
    expect(await inspectSubagent(edited.dir, 'devops', server, edited.m)).toBe('foreign');
    const bare = setup('body', null);
    expect(await inspectSubagent(bare.dir, 'devops', server, bare.m)).toBe('foreign');
    const ours = setup('body', e);
    expect(await inspectSubagent(ours.dir, 'devops', 'https://other', ours.m)).toBe('foreign');
  });
});
