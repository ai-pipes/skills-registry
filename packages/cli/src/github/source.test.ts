import { describe, expect, it } from 'vite-plus/test';
import { UsageError } from '../args.ts';
import { parseSource } from './source.ts';

describe('parseSource', () => {
  it('owner/repo: find by name, optional --ref', () => {
    expect(parseSource('anthropics/skills')).toEqual({
      repo: 'anthropics/skills',
      ref: null,
      path: null,
    });
    expect(parseSource('anthropics/skills', 'v1.2')).toMatchObject({ ref: 'v1.2', path: null });
  });

  it('a repository URL is the skill at the root', () => {
    expect(parseSource('https://github.com/o/r')).toEqual({ repo: 'o/r', ref: null, path: '' });
    expect(parseSource('https://github.com/o/r.git/', 'main')).toEqual({
      repo: 'o/r',
      ref: 'main',
      path: '',
    });
  });

  it('a tree URL: the first segment after tree is the ref, the rest the path', () => {
    expect(
      parseSource('https://github.com/anthropics/skills/tree/main/skills/mcp-builder'),
    ).toEqual({ repo: 'anthropics/skills', ref: 'main', path: 'skills/mcp-builder' });
    expect(parseSource('https://github.com/o/r/tree/v2')).toEqual({
      repo: 'o/r',
      ref: 'v2',
      path: '',
    });
    expect(parseSource('https://github.com/o/r/tree/main/a%20b/c/')).toMatchObject({
      path: 'a b/c',
    });
  });

  it('rejects --ref with a URL ref, other hosts and malformed sources', () => {
    const bad: [string, string?][] = [
      ['https://github.com/o/r/tree/main/x', 'dev'],
      ['https://gitlab.com/o/r'],
      ['gitlab.com/o/r'],
      ['http://github.com/o/r'],
      ['https://github.com/o'],
      ['https://github.com/o/r/blob/main/SKILL.md'],
      ['https://github.com/o/r/tree/main/a%5Cb'],
      ['https://github.com/o/r/tree/main/a%0Ab'],
      ['https://github.com/o/r/tree/main/%E0%A4%A'],
      ['../..'],
      ['a'],
      ['a/b/c'],
      ['o/r', 'a b'],
      ['o/r', ''],
    ];
    for (const [raw, ref] of bad) {
      expect(() => parseSource(raw, ref), raw).toThrow(UsageError);
    }
  });
});
