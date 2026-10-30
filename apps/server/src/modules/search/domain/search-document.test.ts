import { describe, expect, it } from 'vite-plus/test';
import { MAX_PASSAGE_CHARS, buildPassage, skillBody } from './search-document.ts';

describe('skillBody', () => {
  it('strips YAML frontmatter', () => {
    expect(skillBody('---\nname: a\ndescription: b\n---\n# Title\ntext\n')).toBe('# Title\ntext');
    expect(skillBody('---\r\nname: a\r\n---\r\nbody')).toBe('body');
  });

  it('returns the text unchanged without closed frontmatter', () => {
    expect(skillBody('just text')).toBe('just text');
    expect(skillBody('---\nunterminated')).toBe('---\nunterminated');
  });
});

describe('buildPassage', () => {
  it('joins name, description and body', () => {
    expect(buildPassage({ name: 'n', description: 'd', skillMd: '---\nname: n\n---\nbody' })).toBe(
      'n\nd\nbody',
    );
  });

  it('truncates to the passage limit', () => {
    const passage = buildPassage({ name: 'n', description: 'd', skillMd: 'x'.repeat(5000) });
    expect(MAX_PASSAGE_CHARS).toBe(2000);
    expect(passage).toHaveLength(MAX_PASSAGE_CHARS);
  });
});
