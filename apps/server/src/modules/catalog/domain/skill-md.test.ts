import { describe, expect, it } from 'vite-plus/test';
import { parseSkillMd } from './skill-md.ts';

const valid = '---\nname: code-review\ndescription: Reviews code\n---\n# Body\n\ntext\n';

describe('parseSkillMd', () => {
  it('parses name, description and body', () => {
    const r = parseSkillMd(valid);
    expect(r.ok && r.value).toEqual({
      name: 'code-review',
      description: 'Reviews code',
      body: '# Body\n\ntext\n',
      frontmatter: { name: 'code-review', description: 'Reviews code' },
    });
  });

  it('handles BOM and CRLF identically', () => {
    const r = parseSkillMd(`﻿${valid.replaceAll('\n', '\r\n')}`);
    const base = parseSkillMd(valid);
    expect(r).toEqual(base);
  });

  it('allows empty body and closing delimiter at EOF', () => {
    const r = parseSkillMd('---\nname: a\ndescription: b\n---');
    expect(r.ok && r.value.body).toBe('');
  });

  it.each([
    ['no opening delimiter', 'name: a\n'],
    ['no closing delimiter', '---\nname: a\ndescription: b\n'],
    ['missing description', '---\nname: a\n---\nx'],
    ['missing name', '---\ndescription: a\n---\nx'],
    ['empty name', '---\nname: ""\ndescription: a\n---\nx'],
    ['non-string description', '---\nname: a\ndescription: 5\n---\nx'],
    ['description too long', `---\nname: a\ndescription: ${'x'.repeat(1025)}\n---\nx`],
    ['frontmatter is a list', '---\n- a\n---\nx'],
    ['frontmatter is empty', '---\n---\nx'],
    ['invalid yaml', '---\nname: [unclosed\n---\nx'],
  ])('rejects: %s', (_label, text) => {
    const r = parseSkillMd(text);
    expect(!r.ok && r.error.code).toBe('invalid_frontmatter');
  });

  it('a YAML error names the position, never the frontmatter text', () => {
    const r = parseSkillMd('---\nname: secret-value\ndescription: [unclosed secret\n---\nx');
    expect(!r.ok && r.error.message).toMatch(
      /^frontmatter is not valid YAML \(line \d+, column \d+\)$/,
    );
    expect(!r.ok && r.error.message).not.toContain('secret');
  });

  it('accepts description of exactly 1024 chars', () => {
    const r = parseSkillMd(`---\nname: a\ndescription: ${'x'.repeat(1024)}\n---\n`);
    expect(r.ok).toBe(true);
  });
});
