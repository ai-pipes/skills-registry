import { UsageError } from '../args.ts';

/**
 * What to import from GitHub: `repo` is `owner/name`; `ref` null is the default branch; `path`
 * null means "find the skill by name", `''` is the repository root.
 */
export type GithubTarget = { repo: string; ref: string | null; path: string | null };

const NAME = /^[A-Za-z0-9._-]+$/;
const HINT = 'use owner/repo or https://github.com/owner/repo/tree/<ref>/<path>';

function hasControl(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    const code = s.charCodeAt(i);
    if (code <= 0x20 || code === 0x7f) return true;
  }
  return false;
}

function checkRepo(owner: string, name: string, raw: string): string {
  const ok = [owner, name].every((s) => NAME.test(s) && s !== '.' && s !== '..');
  const repo = `${owner}/${name}`;
  if (!ok || repo.length > 200) throw new UsageError(`invalid repository in "${raw}"; ${HINT}`);
  return repo;
}

function checkRef(ref: string): string {
  if (ref === '' || ref.length > 255 || hasControl(ref)) {
    throw new UsageError(`invalid ref "${ref}"`);
  }
  return ref;
}

function decode(segment: string, raw: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    throw new UsageError(`invalid source "${raw}"; ${HINT}`);
  }
}

/**
 * `owner/repo`, `https://github.com/owner/repo` (the skill at the root) or
 * `https://github.com/owner/repo/tree/<ref>/<path…>` (the first segment after `tree` is the ref).
 * `ref` (`--ref`) cannot be combined with a URL that names a ref.
 */
export function parseSource(raw: string, ref?: string): GithubTarget {
  const explicitRef = ref === undefined ? null : checkRef(ref);
  const short = /^([^/]+)\/([^/]+)$/.exec(raw);
  if (short && !raw.includes(':')) {
    return { repo: checkRepo(short[1] ?? '', short[2] ?? '', raw), ref: explicitRef, path: null };
  }
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new UsageError(`unsupported source "${raw}"; ${HINT}`);
  }
  const host = url.hostname === 'github.com' || url.hostname === 'www.github.com';
  if (url.protocol !== 'https:' || !host || url.port || url.username || url.search || url.hash) {
    throw new UsageError(`unsupported source "${raw}"; ${HINT}`);
  }
  const segs = url.pathname
    .split('/')
    .filter((s) => s !== '')
    .map((s) => decode(s, raw));
  const [owner, name, tree, urlRef, ...path] = segs;
  if (owner === undefined || name === undefined) {
    throw new UsageError(`unsupported source "${raw}"; ${HINT}`);
  }
  const repo = checkRepo(owner, name.replace(/\.git$/, ''), raw);
  if (tree === undefined) return { repo, ref: explicitRef, path: '' };
  if (tree !== 'tree' || urlRef === undefined) {
    throw new UsageError(`unsupported source "${raw}"; ${HINT}`);
  }
  if (explicitRef !== null)
    throw new UsageError('--ref cannot be used with a URL that names a ref');
  for (const s of path) {
    if (s === '.' || s === '..' || s.includes('\\') || hasControl(s.replace(/ /g, ''))) {
      throw new UsageError(`invalid path in "${raw}"`);
    }
  }
  return { repo, ref: checkRef(urlRef), path: path.join('/') };
}
