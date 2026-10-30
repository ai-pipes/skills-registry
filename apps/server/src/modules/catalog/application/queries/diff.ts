import { createTwoFilesPatch } from 'diff';
import { err, ok, type Result } from '../../../../shared-kernel/index.ts';
import { CatalogError } from '../../domain/errors.ts';
import type { ManifestEntry } from '../../domain/manifest.ts';
import type { CatalogDeps } from '../deps.ts';
import { loadSkill } from './load.ts';

export type FileDiff = {
  path: string;
  status: 'added' | 'removed' | 'modified' | 'unchanged';
  patch: string | null;
  /** Set when the diff was skipped or abandoned because the content is too large to diff. */
  tooLarge?: true;
};

// Bounds on diff CPU: per-diff abort, per-file size cap and a per-request character budget.
const DIFF_TIMEOUT_MS = 1000;
const DIFF_MAX_EDIT_LENGTH = 10_000;
const MAX_FILE_CHARS = 200_000;
const MAX_REQUEST_CHARS = 1_000_000;

async function readText(blobs: CatalogDeps['blobs'], entry: ManifestEntry | undefined) {
  if (!entry) return '';
  const bytes = await blobs.get(entry.hash);
  if (!bytes) throw new Error(`blob ${entry.hash.value} is missing`);
  return new TextDecoder().decode(bytes);
}

function statusOf(a: ManifestEntry | undefined, b: ManifestEntry | undefined): FileDiff['status'] {
  if (!a) return 'added';
  if (!b) return 'removed';
  return a.hash.equals(b.hash) ? 'unchanged' : 'modified';
}

export async function diffVersions(
  deps: Pick<CatalogDeps, 'skills' | 'blobs'>,
  q: { slug: string; from: number; to: number },
): Promise<Result<FileDiff[], CatalogError>> {
  const skill = await loadSkill(deps.skills, q.slug);
  if (!skill.ok) return skill;
  const [from, to] = await Promise.all([
    deps.skills.getVersion(skill.value.id, q.from),
    deps.skills.getVersion(skill.value.id, q.to),
  ]);
  if (!from || !to) {
    return err(new CatalogError('version_not_found', `version ${from ? q.to : q.from} not found`));
  }
  const before = new Map(from.manifest.entries.map((e) => [e.path.value, e]));
  const after = new Map(to.manifest.entries.map((e) => [e.path.value, e]));
  const paths = [...new Set([...before.keys(), ...after.keys()])].toSorted();

  // Decisions use the manifest's stored size (bytes, an upper bound on chars) before any blob
  // is read; modified pairs are then processed one at a time so only one pair is in memory.
  let budget = 0;
  const diffPath = async (path: string): Promise<FileDiff> => {
    const a = before.get(path);
    const b = after.get(path);
    const status = statusOf(a, b);
    const binary = (a?.binary ?? false) || (b?.binary ?? false);
    if (status === 'unchanged' || binary) return { path, status, patch: null };
    if (Math.max(a?.size ?? 0, b?.size ?? 0) > MAX_FILE_CHARS || budget >= MAX_REQUEST_CHARS) {
      return { path, status, patch: null, tooLarge: true };
    }
    const [oldText, newText] = await Promise.all([
      readText(deps.blobs, a),
      readText(deps.blobs, b),
    ]);
    budget += oldText.length + newText.length;
    const patch = createTwoFilesPatch(path, path, oldText, newText, undefined, undefined, {
      timeout: DIFF_TIMEOUT_MS,
      maxEditLength: DIFF_MAX_EDIT_LENGTH,
    });
    return patch === undefined
      ? { path, status, patch: null, tooLarge: true }
      : { path, status, patch };
  };
  const out = await paths.reduce<Promise<FileDiff[]>>(async (prev, path) => {
    const acc = await prev;
    acc.push(await diffPath(path));
    return acc;
  }, Promise.resolve([]));
  return ok(out);
}
