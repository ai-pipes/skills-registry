import { describe, expect, it } from 'vite-plus/test';
import { sourceLabel } from './source-message.ts';

const SHA = '0123456789abcdef0123456789abcdef01234567';

describe('sourceLabel', () => {
  it('is owner/repo/path@sha7', () => {
    expect(sourceLabel({ repo: 'anthropics/skills', path: 'skills/pdf' }, SHA)).toBe(
      'anthropics/skills/skills/pdf@0123456',
    );
  });

  it('has no extra slash for a skill at the repository root', () => {
    expect(sourceLabel({ repo: 'o/r', path: '' }, SHA)).toBe('o/r@0123456');
  });
});
