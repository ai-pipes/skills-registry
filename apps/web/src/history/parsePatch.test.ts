import { describe, expect, it } from 'vite-plus/test';
import { parsePatch } from './parsePatch.ts';

const TWO_HUNKS = [
  'Index: SKILL.md',
  '===================================================================',
  '--- SKILL.md',
  '+++ SKILL.md',
  '@@ -1,3 +1,4 @@',
  ' line 1',
  '-line 2',
  '+second',
  '+one more',
  ' line 3',
  '@@ -28,3 +29,2 @@',
  ' line 27',
  '-line 28',
  ' line 29',
  '\\ No newline at end of file',
  '',
].join('\n');

describe('parsePatch', () => {
  it('numbers lines across two hunks with additions, deletions and Cyrillic', () => {
    const { hunks } = parsePatch(TWO_HUNKS);
    expect(hunks.map((h) => h.header)).toEqual(['@@ -1,3 +1,4 @@', '@@ -28,3 +29,2 @@']);
    expect(hunks[0]?.lines).toEqual([
      { kind: 'ctx', oldNo: 1, newNo: 1, text: 'line 1' },
      { kind: 'del', oldNo: 2, newNo: null, text: 'line 2' },
      { kind: 'add', oldNo: null, newNo: 2, text: 'second' },
      { kind: 'add', oldNo: null, newNo: 3, text: 'one more' },
      { kind: 'ctx', oldNo: 3, newNo: 4, text: 'line 3' },
    ]);
    expect(hunks[1]?.lines).toEqual([
      { kind: 'ctx', oldNo: 28, newNo: 29, text: 'line 27' },
      { kind: 'del', oldNo: 29, newNo: null, text: 'line 28' },
      { kind: 'ctx', oldNo: 30, newNo: 30, text: 'line 29' },
    ]);
  });

  it('keeps content lines that start with dashes inside a hunk', () => {
    const { hunks } = parsePatch(
      '--- f\n+++ f\n@@ -1,1 +1,1 @@\n--- not a header\n+++ also content\n',
    );
    expect(hunks[0]?.lines).toEqual([
      { kind: 'del', oldNo: 1, newNo: null, text: '-- not a header' },
      { kind: 'add', oldNo: null, newNo: 1, text: '++ also content' },
    ]);
  });

  it('returns no hunks for an empty patch', () => {
    expect(parsePatch('').hunks).toEqual([]);
  });
});
