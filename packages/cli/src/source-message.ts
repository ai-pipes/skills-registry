/** `owner/repo/path` (or `owner/repo` for a skill at the repository root). */
export function sourceName(s: { repo: string; path: string }): string {
  return s.path === '' ? s.repo : `${s.repo}/${s.path}`;
}

/** `owner/repo/path@sha7`: the source and commit in version messages and output. */
export function sourceLabel(s: { repo: string; path: string }, commit: string): string {
  return `${sourceName(s)}@${commit.slice(0, 7)}`;
}
