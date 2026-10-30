import { describe, expect, it } from 'vite-plus/test';
import { parseSourceCommit, parseSourceRef } from './source.ts';

const base = {
  host: 'github.com',
  repo: 'anthropics/skills',
  path: 'skills/mcp-builder',
  ref: null,
};
const code = (r: { ok: boolean; error?: { code: string } }) => (r.ok ? 'ok' : r.error?.code);

describe('parseSourceRef', () => {
  it('accepts a GitHub repository path, normalized, and the repository root', () => {
    expect(parseSourceRef(base)).toEqual({ ok: true, value: base });
    expect(parseSourceRef({ ...base, path: './skills//mcp-builder/' })).toEqual({
      ok: true,
      value: base,
    });
    expect(parseSourceRef({ ...base, path: '' })).toEqual({
      ok: true,
      value: { ...base, path: '' },
    });
    expect(parseSourceRef({ ...base, ref: 'v1.2.0' })).toEqual({
      ok: true,
      value: { ...base, ref: 'v1.2.0' },
    });
  });

  it.each([
    { host: 'gitlab.com' },
    { repo: 'a' },
    { repo: 'a/b/c' },
    { repo: 'a b/c' },
    { repo: `${'a'.repeat(100)}/${'b'.repeat(100)}` },
    { path: '../x' },
    { ref: 'a b' },
    { ref: '' },
    { ref: 'a\u0007' },
    { ref: 'r'.repeat(256) },
  ])('rejects %o', (patch) => {
    expect(code(parseSourceRef({ ...base, ...patch }))).toBe('invalid_source');
  });
});

describe('parseSourceCommit', () => {
  it('accepts 40 lowercase hex characters only', () => {
    expect(parseSourceCommit('a'.repeat(40))).toEqual({ ok: true, value: 'a'.repeat(40) });
    expect(code(parseSourceCommit('A'.repeat(40)))).toBe('invalid_source');
    expect(code(parseSourceCommit('abc'))).toBe('invalid_source');
  });
});
