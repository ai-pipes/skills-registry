import { createHash } from 'node:crypto';
import type { SkillView } from '@skills/contracts';

/** Path → sha256 (hex) of every file of a skill version, `SKILL.md` included. */
export type LocalManifest = Map<string, string>;

/** The manifest of a registry version. */
export function manifestOf(view: SkillView): LocalManifest {
  const m: LocalManifest = new Map(view.files.map((f) => [f.path, f.sha256]));
  if (!m.has('SKILL.md')) m.set('SKILL.md', view.skillMdSha256);
  return m;
}

export const sha256 = (b: Uint8Array): string => createHash('sha256').update(b).digest('hex');

export function hashFiles(files: Map<string, Uint8Array>): LocalManifest {
  const m: LocalManifest = new Map();
  for (const [path, bytes] of files) m.set(path, sha256(bytes));
  return m;
}

const sorted = (paths: Iterable<string>) => [...paths].toSorted();

/** What changes from `a` to `b`; each list sorted. */
export function diffManifests(
  a: LocalManifest,
  b: LocalManifest,
): { added: string[]; modified: string[]; removed: string[] } {
  return {
    added: sorted([...b.keys()].filter((p) => !a.has(p))),
    modified: sorted([...b].filter(([p, h]) => a.has(p) && a.get(p) !== h).map(([p]) => p)),
    removed: sorted([...a.keys()].filter((p) => !b.has(p))),
  };
}

export function sameManifest(a: LocalManifest, b: LocalManifest): boolean {
  return a.size === b.size && [...a].every(([p, h]) => b.get(p) === h);
}
