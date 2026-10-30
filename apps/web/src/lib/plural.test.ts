import { describe, expect, it } from 'vite-plus/test';
import { strings } from '@/strings.ts';
import { plural } from './plural.ts';

const files = { one: 'file', other: 'files' };

describe('plural', () => {
  it.each([
    [0, 'files'],
    [1, 'file'],
    [2, 'files'],
    [5, 'files'],
    [11, 'files'],
    [21, 'files'],
    [101, 'files'],
    [1.5, 'files'],
  ])('%d → %s', (n, form) => {
    expect(plural(n, files)).toBe(form);
  });

  it('agrees the count strings', () => {
    expect(strings.history.unchangedFiles(1)).toBe('1 unchanged file');
    expect(strings.history.unchangedFiles(3)).toBe('3 unchanged files');
    expect(strings.skills.found(1)).toBe('1 skill found');
    expect(strings.skills.found(2)).toBe('2 skills found');
    expect(strings.skills.found(0)).toBe('0 skills found');
    expect(strings.login.rateLimited(1)).toBe('Too many attempts. Try again in 1 minute.');
    expect(strings.login.rateLimited(15)).toBe('Too many attempts. Try again in 15 minutes.');
  });
});
