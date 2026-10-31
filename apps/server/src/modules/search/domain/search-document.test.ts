import { describe, expect, it } from 'vite-plus/test';
import { MAX_PASSAGE_CHARS, buildPassage, documentBody } from './search-document.ts';

describe('documentBody', () => {
  it('strips YAML frontmatter', () => {
    expect(documentBody('---\nname: a\ndescription: b\n---\n# Title\ntext\n')).toBe(
      '# Title\ntext',
    );
    expect(documentBody('---\r\nname: a\r\n---\r\nbody')).toBe('body');
  });

  it('returns the text unchanged without closed frontmatter', () => {
    expect(documentBody('just text')).toBe('just text');
    expect(documentBody('---\nunterminated')).toBe('---\nunterminated');
  });
});

describe('buildPassage', () => {
  it('joins name, description and body', () => {
    expect(buildPassage({ name: 'n', description: 'd', body: 'body' })).toBe('n\nd\nbody');
  });

  it('truncates to the passage limit', () => {
    const passage = buildPassage({ name: 'n', description: 'd', body: 'x'.repeat(5000) });
    expect(MAX_PASSAGE_CHARS).toBe(2000);
    expect(passage).toHaveLength(MAX_PASSAGE_CHARS);
  });
});
