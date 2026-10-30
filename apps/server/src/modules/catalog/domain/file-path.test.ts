import { describe, expect, it } from 'vite-plus/test';
import { FilePath } from './file-path.ts';

describe('FilePath', () => {
  it.each(['./references/a.md', '/references/a.md', 'references\\a.md', 'references//a.md'])(
    'normalizes %j',
    (raw) => {
      const r = FilePath.parse(raw);
      expect(r.ok && r.value.value).toBe('references/a.md');
    },
  );

  it.each(['../x', 'a/../b', 'a/./b', '', '/', 'a\0b', `${'a/'.repeat(128)}a`, 'b'.repeat(101)])(
    'rejects %j',
    (raw) => {
      const r = FilePath.parse(raw);
      expect(!r.ok && r.error.code).toBe('invalid_path');
    },
  );

  it('exposes SKILL_MD and equality', () => {
    expect(FilePath.SKILL_MD).toBe('SKILL.md');
    const a = FilePath.parse('SKILL.md');
    const b = FilePath.parse('./SKILL.md');
    expect(a.ok && b.ok && a.value.equals(b.value)).toBe(true);
    expect(a.ok && a.value.toString()).toBe('SKILL.md');
  });
});
