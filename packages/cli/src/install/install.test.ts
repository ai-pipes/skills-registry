import { createHash } from 'node:crypto';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  realpathSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vite-plus/test';
import { UsageError } from '../args.ts';
import { fakeEnv } from '../../test/fake-env.ts';
import { AGENTS, selectAgents } from './agents.ts';
import { inParallel, planInstall } from './layout.ts';
import { inspectLink, MARKER, readMarker, verifyMarker, type Marker } from './marker.ts';
import { checkPath, linkOrCopy, writeSkillDir } from './write.ts';

const sha = (s: string | Uint8Array) => createHash('sha256').update(s).digest('hex');
const enc = (s: string) => new TextEncoder().encode(s);
const agent = (id: string) => AGENTS.find((a) => a.id === id)!;

describe('selectAgents', () => {
  it('detects agents by their home directory; * is all; unknown is a usage error', () => {
    const env = fakeEnv();
    expect(selectAgents([], env)).toEqual([]);
    mkdirSync(join(env.home, '.cursor'));
    mkdirSync(join(env.home, '.config', 'opencode'), { recursive: true });
    expect(selectAgents([], env).map((a) => a.id)).toEqual(['cursor', 'opencode']);
    expect(selectAgents(['*'], env)).toEqual(AGENTS);
    expect(selectAgents(['codex', 'codex'], env).map((a) => a.id)).toEqual(['codex']);
    expect(() => selectAgents(['vim'], env)).toThrow(UsageError);
    expect(() => selectAgents(['vim'], env)).toThrow(/unknown agent "vim"; known: claude-code/);
  });
});

describe('planInstall', () => {
  it('project: canonical .agents/skills, links only for other directories, deduplicated', () => {
    const env = fakeEnv();
    const plan = planInstall({
      slug: 'x',
      agents: [agent('claude-code'), agent('cursor'), agent('windsurf'), agent('claude-code')],
      global: false,
      dir: undefined,
      env,
    });
    expect(plan.canonical).toBe(join(env.cwd, '.agents/skills/x'));
    expect(plan.links).toEqual([
      { agent: 'claude-code', path: join(env.cwd, '.claude/skills/x') },
      { agent: 'windsurf', path: join(env.cwd, '.windsurf/skills/x') },
    ]);
  });

  it('global: under home with the global agent paths; --dir: only that directory', () => {
    const env = fakeEnv();
    const g = planInstall({
      slug: 'x',
      agents: [agent('cursor'), agent('codex')],
      global: true,
      dir: undefined,
      env,
    });
    expect(g.canonical).toBe(join(env.home, '.agents/skills/x'));
    expect(g.links).toEqual([{ agent: 'cursor', path: join(env.home, '.cursor/skills/x') }]);
    const d = planInstall({ slug: 'x', agents: [agent('cursor')], global: false, dir: 'out', env });
    expect(d).toEqual({ canonical: join(env.cwd, 'out/x'), links: [] });
  });
});

describe('checkPath', () => {
  it.each(['../evil', '/abs', 'a/../../b', 'a//b', './a', '', 'a\0b', 'a\\b', MARKER])(
    'rejects %j',
    (p) => expect(() => checkPath(p)).toThrow(/unsafe file path/),
  );
  it('accepts nested paths', () => expect(() => checkPath('a/b/c.png')).not.toThrow());
});

describe('writeSkillDir and markers', () => {
  const files = new Map([
    ['SKILL.md', enc('# x')],
    ['scripts/run.sh', enc('echo')],
    ['img/a.bin', new Uint8Array([0, 255, 1])],
  ]);
  const marker = (version: number): Marker => ({
    server: 'https://r.example',
    slug: 'x',
    version,
    files: Object.fromEntries([...files].map(([p, b]) => [p, sha(b)])),
  });

  it('writes files and the marker, replaces an older copy and leaves no temp dirs', async () => {
    const env = fakeEnv();
    const target = join(env.cwd, 'skills', 'x');
    await writeSkillDir(target, files, marker(1));
    expect(readFileSync(join(target, 'img/a.bin'))).toEqual(Buffer.from([0, 255, 1]));
    expect(await readMarker(target)).toEqual(marker(1));
    expect(await verifyMarker(target, marker(1))).toBe(true);

    writeFileSync(join(target, 'stale.txt'), 'old');
    await writeSkillDir(target, files, marker(2));
    expect(existsSync(join(target, 'stale.txt'))).toBe(false);
    expect((await readMarker(target))?.version).toBe(2);
    expect(readdirSync(join(env.cwd, 'skills'))).toEqual(['x']);
  });

  it('an unsafe path fails before anything is written', async () => {
    const env = fakeEnv();
    const target = join(env.cwd, 'skills', 'x');
    const bad = new Map([...files, ['../evil', enc('!')]]);
    await expect(writeSkillDir(target, bad, marker(1))).rejects.toThrow(/unsafe file path/);
    expect(existsSync(join(env.cwd, 'skills'))).toBe(false);
  });

  it('verifyMarker: a modified, missing or extra file fails; readMarker: missing or invalid is null', async () => {
    const env = fakeEnv();
    const target = join(env.cwd, 'x');
    expect(await readMarker(target)).toBeNull();
    await writeSkillDir(target, files, marker(1));
    writeFileSync(join(target, 'extra.txt'), '!');
    expect(await verifyMarker(target, marker(1))).toBe(false);
    await writeSkillDir(target, files, marker(1));
    writeFileSync(join(target, 'SKILL.md'), 'changed');
    expect(await verifyMarker(target, marker(1))).toBe(false);
    await writeSkillDir(target, new Map([['SKILL.md', enc('# x')]]), marker(1));
    expect(await verifyMarker(target, marker(1))).toBe(false);
    writeFileSync(join(target, MARKER), '{"slug": 1}');
    expect(await readMarker(target)).toBeNull();
  });
});

describe('linkOrCopy', () => {
  it('a relative symlink; a copy with copy: true', async () => {
    const env = fakeEnv();
    const canonical = join(env.cwd, '.agents/skills/x');
    mkdirSync(canonical, { recursive: true });
    writeFileSync(join(canonical, 'SKILL.md'), '# x');
    const link = join(env.cwd, '.claude/skills/x');
    expect(await linkOrCopy(canonical, link, { copy: false, platform: 'linux' })).toBe('link');
    expect(readlinkSync(link)).toBe('../../.agents/skills/x');
    const copy = join(env.cwd, '.roo/skills/x');
    expect(await linkOrCopy(canonical, copy, { copy: true, platform: 'linux' })).toBe('copy');
    expect(lstatSync(copy).isDirectory()).toBe(true);
    expect(readFileSync(join(copy, 'SKILL.md'), 'utf8')).toBe('# x');
  });
});

describe('symlinked agent skills directory', () => {
  it('the link resolves to canonical through a symlinked parent and inspectLink sees it', async () => {
    const env = fakeEnv();
    const canonical = join(env.cwd, '.agents/skills/x');
    mkdirSync(canonical, { recursive: true });
    writeFileSync(join(canonical, 'SKILL.md'), '# x');
    const real = join(env.cwd, 'deep/a/b/skills');
    mkdirSync(real, { recursive: true });
    mkdirSync(join(env.cwd, '.claude'));
    symlinkSync(real, join(env.cwd, '.claude/skills'), 'dir');
    const link = join(env.cwd, '.claude/skills/x');
    expect(await linkOrCopy(canonical, link, { copy: false, platform: 'linux' })).toBe('link');
    expect(readFileSync(join(link, 'SKILL.md'), 'utf8')).toBe('# x');
    expect(realpathSync(link)).toBe(realpathSync(canonical));
    expect(await inspectLink(link, canonical, { slug: 'x' })).toBe('link');
  });

  it('inspectLink: a dangling or elsewhere-pointing symlink is foreign', async () => {
    const env = fakeEnv();
    const canonical = join(env.cwd, '.agents/skills/x');
    mkdirSync(canonical, { recursive: true });
    mkdirSync(join(env.cwd, 'other'));
    mkdirSync(join(env.cwd, '.claude/skills'), { recursive: true });
    symlinkSync('../../other', join(env.cwd, '.claude/skills/x'), 'dir');
    symlinkSync('../../missing', join(env.cwd, '.claude/skills/y'), 'dir');
    expect(await inspectLink(join(env.cwd, '.claude/skills/x'), canonical, { slug: 'x' })).toBe(
      'foreign',
    );
    expect(await inspectLink(join(env.cwd, '.claude/skills/y'), canonical, { slug: 'x' })).toBe(
      'foreign',
    );
  });
});

describe('inParallel', () => {
  it('runs at most `limit` at once and keeps the results in order', async () => {
    let running = 0;
    let peak = 0;
    const items = Array.from({ length: 20 }, (_, i) => i);
    const out = await inParallel(items, 8, async (i) => {
      running++;
      peak = Math.max(peak, running);
      await new Promise((r) => setTimeout(r, (i * 7) % 5));
      running--;
      return i * 2;
    });
    expect(out).toEqual(items.map((i) => i * 2));
    expect(peak).toBe(8);
    expect(await inParallel([], 8, async () => 1)).toEqual([]);
  });

  it('rejects with the first failure', async () => {
    await expect(
      inParallel([1, 2, 3], 2, async (i) => {
        if (i === 2) throw new Error('boom');
        return i;
      }),
    ).rejects.toThrow('boom');
  });
});
