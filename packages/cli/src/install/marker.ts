import { lstat, readFile, readdir, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { isNotFound } from '../fs-errors.ts';
import { sha256 } from '../manifest.ts';

/** The service file in an installed skill directory (no token in it). */
export const MARKER = '.skills-registry.json';

const MarkerFile = z.object({
  server: z.string(),
  slug: z.string(),
  version: z.number().int().positive(),
  files: z.record(z.string(), z.string()),
});

export type Marker = z.infer<typeof MarkerFile>;

/** The marker of `dir`; `null` when there is none or it is not a valid marker. */
export async function readMarker(dir: string): Promise<Marker | null> {
  try {
    const parsed = MarkerFile.safeParse(JSON.parse(await readFile(join(dir, MARKER), 'utf8')));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/** Every regular file under `dir` (relative `/`-paths); `null` if anything else is there. */
async function listFiles(dir: string, prefix = ''): Promise<string[] | null> {
  const entries = await readdir(join(dir, prefix), { withFileTypes: true });
  const lists = await Promise.all(
    entries.map(async (e): Promise<string[] | null> => {
      const rel = prefix === '' ? e.name : `${prefix}/${e.name}`;
      if (e.isDirectory()) return listFiles(dir, rel);
      return e.isFile() ? [rel] : null;
    }),
  );
  return lists.some((l) => l === null) ? null : lists.flatMap((l) => l ?? []);
}

/** The files on disk are exactly the marker's (same paths and sha256), besides the marker itself. */
export async function verifyMarker(dir: string, m: Marker): Promise<boolean> {
  const found = await listFiles(dir);
  if (found === null) return false;
  const files = found.filter((p) => p !== MARKER);
  if (files.length !== Object.keys(m.files).length) return false;
  if (!files.every((p) => Object.hasOwn(m.files, p))) return false;
  const same = await Promise.all(
    files.map(async (p) => sha256(await readFile(join(dir, p))) === m.files[p]),
  );
  return same.every(Boolean);
}

/** What is at a path: nothing, something that is not our intact install, or our install. */
export type Installed = 'absent' | 'foreign' | Marker;

/**
 * `dir` holds an intact install of `slug` (from `server`, when given): a directory with a valid
 * marker and exactly the marked files.
 */
export async function inspectDir(
  dir: string,
  want: { slug: string; server?: string },
): Promise<Installed> {
  let st;
  try {
    st = await lstat(dir);
  } catch (e) {
    if (isNotFound(e)) return 'absent';
    throw e;
  }
  if (!st.isDirectory()) return 'foreign';
  const m = await readMarker(dir);
  if (m === null || m.slug !== want.slug) return 'foreign';
  if (want.server !== undefined && m.server !== want.server) return 'foreign';
  return (await verifyMarker(dir, m)) ? m : 'foreign';
}

/** The real path of `p`; `null` when it (or what it points to) does not exist. */
const realOrNull = (p: string) => realpath(p).catch(() => null);

/** An agent path: absent, our symlink to `canonical`, our copy, or something else. */
export async function inspectLink(
  path: string,
  canonical: string,
  want: { slug: string; server?: string },
): Promise<'absent' | 'link' | 'copy' | 'foreign'> {
  let st;
  try {
    st = await lstat(path);
  } catch (e) {
    if (isNotFound(e)) return 'absent';
    throw e;
  }
  if (st.isSymbolicLink()) {
    const [target, canon] = await Promise.all([realOrNull(path), realOrNull(canonical)]);
    return target !== null && target === canon ? 'link' : 'foreign';
  }
  return typeof (await inspectDir(path, want)) === 'object' ? 'copy' : 'foreign';
}
