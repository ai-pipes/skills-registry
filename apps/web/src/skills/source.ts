const REPO = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/;
const COMMIT = /^[0-9a-f]{40}$/;

/**
 * The GitHub page of an imported skill at `commit`, or null when `repo`/`commit` do not look
 * like an `owner/name` and a full SHA (the source is untrusted input: never build a link from it
 * otherwise).
 */
export function githubUrl(source: { repo: string; path: string }, commit: string): string | null {
  if (!REPO.test(source.repo) || !COMMIT.test(commit)) return null;
  const path = source.path
    .split('/')
    .filter((s) => s !== '')
    .map(encodeURIComponent)
    .join('/');
  return `https://github.com/${source.repo}/tree/${commit}${path === '' ? '' : `/${path}`}`;
}

/** `owner/repo/path` (`owner/repo` for a skill at the repository root). */
export function sourceLabel(source: { repo: string; path: string }): string {
  return source.path === '' ? source.repo : `${source.repo}/${source.path}`;
}

/** The short form of a commit SHA. */
export function shortSha(commit: string): string {
  return commit.slice(0, 7);
}
