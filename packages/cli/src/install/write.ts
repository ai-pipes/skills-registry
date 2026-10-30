import { cp, mkdir, mkdtemp, realpath, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { basename, dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { isNotFound } from '../fs-errors.ts';
import { safe } from '../output.ts';
import { MARKER, type Marker } from './marker.ts';

/** A server-provided file path must be a plain relative `/`-path (not the marker itself). */
export function checkPath(p: string): void {
  const bad =
    p === '' ||
    p === MARKER ||
    p.includes('\0') ||
    p.includes('\\') ||
    isAbsolute(p) ||
    p.split('/').some((s) => s === '' || s === '.' || s === '..');
  if (bad) throw new Error(`unsafe file path "${safe(p)}"`);
}

function inside(root: string, p: string): string {
  checkPath(p);
  const full = resolve(root, p);
  if (!full.startsWith(root + sep)) throw new Error(`unsafe file path "${safe(p)}"`);
  return full;
}

/**
 * Writes `files` and the marker into a temporary sibling of `target`, then renames it into place;
 * a previous `target` is moved aside first and deleted after the rename. Every path is checked
 * before anything is written.
 */
export async function writeSkillDir(
  target: string,
  files: Map<string, Uint8Array>,
  marker: Marker,
): Promise<void> {
  for (const p of files.keys()) checkPath(p);
  const parent = dirname(target);
  await mkdir(parent, { recursive: true });
  const tmp = await mkdtemp(resolve(parent, `.${basename(target)}.tmp-`));
  try {
    const targets = [...files].map(([p, bytes]) => [inside(tmp, p), bytes] as const);
    await Promise.all(
      targets.map(async ([full, bytes]) => {
        await mkdir(dirname(full), { recursive: true });
        await writeFile(full, bytes);
      }),
    );
    await writeFile(resolve(tmp, MARKER), `${JSON.stringify(marker, null, 2)}\n`);
    const old = `${tmp}.old`;
    let moved = false;
    try {
      await rename(target, old);
      moved = true;
    } catch (e) {
      if (!isNotFound(e)) throw e;
    }
    try {
      await rename(tmp, target);
    } catch (e) {
      if (moved) await rename(old, target);
      throw e;
    }
    if (moved) await rm(old, { recursive: true, force: true });
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
}

const isDenied = (e: unknown) =>
  e instanceof Error && 'code' in e && (e.code === 'EPERM' || e.code === 'EACCES');

/**
 * Makes `linkPath` a relative directory symlink to `canonical` (a junction on Windows), or an
 * independent copy with `copy` or when symlinks are not permitted (`'copy'` is returned; the
 * caller warns).
 */
export async function linkOrCopy(
  canonical: string,
  linkPath: string,
  opts: { copy: boolean; platform: NodeJS.Platform },
): Promise<'link' | 'copy'> {
  await mkdir(dirname(linkPath), { recursive: true });
  if (!opts.copy) {
    try {
      if (opts.platform === 'win32') await symlink(canonical, linkPath, 'junction');
      else {
        // Relative between real paths: the agent's skills directory may itself be a symlink.
        const from = await realpath(dirname(linkPath));
        await symlink(relative(from, await realpath(canonical)), linkPath, 'dir');
      }
      return 'link';
    } catch (e) {
      if (!isDenied(e)) throw e;
    }
  }
  await cp(canonical, linkPath, { recursive: true });
  return 'copy';
}
