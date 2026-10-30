import { describe, expect, it } from 'vite-plus/test';
import { skillView } from '../test/registry-fixtures.ts';
import { diffManifests, hashFiles, manifestOf, sameManifest } from './manifest.ts';
import { SkillView } from '@skills/contracts';

const m = (o: Record<string, string>) => new Map(Object.entries(o));

describe('manifest', () => {
  it('hashFiles is path → sha256 hex', () => {
    const files = new Map([['a.md', new TextEncoder().encode('abc')]]);
    expect(hashFiles(files)).toEqual(
      m({ 'a.md': 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad' }),
    );
  });

  it('manifestOf takes the files and SKILL.md of a view', () => {
    const view = SkillView.parse(
      skillView('pdf', { files: [{ path: 'x.md', size: 1, binary: false, sha256: 'b' }] }),
    );
    expect(manifestOf(view)).toEqual(m({ 'x.md': 'b', 'SKILL.md': '0'.repeat(64) }));
  });

  it('diffManifests lists added, modified and removed paths, sorted', () => {
    const a = m({ 'SKILL.md': '1', 'old.md': '2', 'same.md': '3', 'z.md': '4' });
    const b = m({ 'SKILL.md': '9', 'new.md': '5', 'same.md': '3', 'a.md': '8', 'z.md': '0' });
    expect(diffManifests(a, b)).toEqual({
      added: ['a.md', 'new.md'],
      modified: ['SKILL.md', 'z.md'],
      removed: ['old.md'],
    });
  });

  it('sameManifest compares paths and hashes', () => {
    expect(sameManifest(m({ a: '1', b: '2' }), m({ b: '2', a: '1' }))).toBe(true);
    expect(sameManifest(m({ a: '1' }), m({ a: '2' }))).toBe(false);
    expect(sameManifest(m({ a: '1' }), m({ a: '1', b: '2' }))).toBe(false);
  });
});
