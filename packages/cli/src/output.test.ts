import { describe, expect, it } from 'vite-plus/test';
import { safe } from './output.ts';

describe('safe', () => {
  it('replaces C0/C1 control characters, tabs and newlines with ?', () => {
    expect(safe('red \u001b[31mtext\nnext\tcol\u009b\u007f')).toBe('red ?[31mtext?next?col??');
  });

  it('keeps printable text, including non-ASCII', () => {
    expect(safe('Дизайн — PDF 📄')).toBe('Дизайн — PDF 📄');
  });
});
