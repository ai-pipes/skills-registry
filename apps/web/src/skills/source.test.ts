import { describe, expect, it } from 'vite-plus/test';
import { githubUrl } from './source.ts';

const commit = 'a1b2c3d' + '0'.repeat(33);

describe('githubUrl', () => {
  it('links to the path at the commit', () => {
    expect(githubUrl({ repo: 'anthropics/skills', path: 'skills/mcp-builder' }, commit)).toBe(
      `https://github.com/anthropics/skills/tree/${commit}/skills/mcp-builder`,
    );
  });

  it('omits an empty path', () => {
    expect(githubUrl({ repo: 'a.b/c_d-e', path: '' }, commit)).toBe(
      `https://github.com/a.b/c_d-e/tree/${commit}`,
    );
  });

  it('encodes path segments', () => {
    expect(githubUrl({ repo: 'o/r', path: 'a b/#c' }, commit)).toBe(
      `https://github.com/o/r/tree/${commit}/a%20b/%23c`,
    );
  });

  it.each(['javascript:alert(1)', 'o/r/x', 'o', '../o/r', 'o/r?x'])('rejects repo %s', (repo) => {
    expect(githubUrl({ repo, path: '' }, commit)).toBeNull();
  });

  it.each(['a1b2c3d', 'G'.repeat(40), `${commit}0`])('rejects commit %s', (c) => {
    expect(githubUrl({ repo: 'o/r', path: '' }, c)).toBeNull();
  });
});
