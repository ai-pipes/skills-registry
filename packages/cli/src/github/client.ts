import { z } from 'zod';

const RepoInfo = z.object({ default_branch: z.string().min(1) });
const SHA = /^[0-9a-f]{40}$/;

const encodeRef = (ref: string) => ref.split('/').map(encodeURIComponent).join('/');

/** The GitHub REST API (`GITHUB_API_URL`), anonymous or with `GITHUB_TOKEN`. */
export class GithubClient {
  private readonly apiUrl: string;

  constructor(
    private readonly fetchFn: typeof fetch,
    private readonly opts: { apiUrl: string; token?: string },
  ) {
    this.apiUrl = opts.apiUrl.replace(/\/+$/, '');
  }

  private async get(path: string, what: string, accept = 'application/vnd.github+json') {
    const headers: Record<string, string> = {
      accept,
      'user-agent': 'skills-registry-cli',
      'x-github-api-version': '2022-11-28',
    };
    if (this.opts.token) headers.authorization = `Bearer ${this.opts.token}`;
    let res: Response;
    try {
      res = await this.fetchFn(`${this.apiUrl}${path}`, { headers, redirect: 'follow' });
    } catch (e) {
      throw new Error(`cannot reach GitHub: ${e instanceof Error ? e.message : String(e)}`, {
        cause: e,
      });
    }
    if (res.ok) return res;
    await res.body?.cancel();
    if (res.status === 404) throw new Error(`repository or ref not found: ${what}`);
    if (
      (res.status === 403 || res.status === 429) &&
      res.headers.get('x-ratelimit-remaining') === '0'
    ) {
      throw new Error('GitHub rate limit; set GITHUB_TOKEN');
    }
    if (res.status === 401) throw new Error('GitHub rejected GITHUB_TOKEN');
    throw new Error(`GitHub answered HTTP ${res.status} for ${what}`);
  }

  /** The commit SHA of `ref`; `null` is the repository's default branch. */
  async resolveCommit(repo: string, ref: string | null): Promise<string> {
    let name = ref;
    if (name === null) {
      const info = RepoInfo.safeParse(await (await this.get(`/repos/${repo}`, repo)).json());
      if (!info.success) throw new Error(`unexpected GitHub answer for ${repo}`);
      name = info.data.default_branch;
    }
    const res = await this.get(
      `/repos/${repo}/commits/${encodeRef(name)}`,
      `${repo}@${name}`,
      'application/vnd.github.sha',
    );
    const sha = (await res.text()).trim();
    if (!SHA.test(sha)) throw new Error(`unexpected GitHub answer for ${repo}@${name}`);
    return sha;
  }

  /** The gzip tarball of the commit (GitHub redirects to codeload; the redirect is followed). */
  async tarball(repo: string, sha: string): Promise<ReadableStream<Uint8Array>> {
    const res = await this.get(`/repos/${repo}/tarball/${sha}`, `${repo}@${sha}`);
    if (res.body === null) throw new Error(`empty tarball for ${repo}@${sha}`);
    return res.body;
  }
}
