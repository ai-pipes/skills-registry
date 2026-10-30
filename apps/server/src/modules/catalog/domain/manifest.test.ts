import { describe, expect, it } from 'vite-plus/test';
import { ContentHash } from './content-hash.ts';
import { FilePath } from './file-path.ts';
import { type ManifestEntry, SkillManifest } from './manifest.ts';

const entry = (path: string, size = 10): ManifestEntry => {
  const p = FilePath.parse(path);
  const h = ContentHash.parse('b'.repeat(64));
  if (!p.ok || !h.ok) throw new Error('bad fixture');
  return { path: p.value, hash: h.value, size, binary: false };
};

describe('SkillManifest', () => {
  it('creates with SKILL.md, exposes entries, get and totalSize', () => {
    const r = SkillManifest.create([entry('SKILL.md', 5), entry('references/a.md', 7)]);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.entries).toHaveLength(2);
    expect(r.value.totalSize).toBe(12);
    const key = FilePath.parse('references/a.md');
    expect(key.ok && r.value.get(key.value)?.size).toBe(7);
    const missing = FilePath.parse('nope.md');
    expect(missing.ok && r.value.get(missing.value)).toBeUndefined();
  });

  it('rejects a manifest without SKILL.md', () => {
    const r = SkillManifest.create([entry('a.md')]);
    expect(!r.ok && r.error.code).toBe('missing_skill_md');
  });

  it('rejects case-insensitive duplicate paths', () => {
    const r = SkillManifest.create([entry('SKILL.md'), entry('A.md'), entry('a.md')]);
    expect(!r.ok && r.error.code).toBe('duplicate_path');
  });
});
