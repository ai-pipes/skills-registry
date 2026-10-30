import {
  ErrorBody,
  FolderRef,
  type FolderStatusFilter,
  FolderSummary,
  MeResponse,
  type SkillStatusFilter,
  SkillSummary,
  SkillView,
  VersionRef,
  VersionSummary,
} from '@skills/contracts';
import type { ZodType } from 'zod';
import type { Connection } from './config.ts';

/** A failed registry call: HTTP status (0 when the server was not reached) and error code. */
export class RegistryError extends Error {
  override name = 'RegistryError';
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

type SourceFields = {
  host: string;
  repo: string;
  path: string;
  ref: string | null;
  commit: string;
};

function basename(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1);
}

/** Every file part's field name is its path (as the web client sends it). */
function appendFiles(form: FormData, files: Map<string, Uint8Array>): void {
  for (const [path, bytes] of files) {
    form.append(path, new Blob([new Uint8Array(bytes)]), basename(path));
  }
}

/**
 * Typed REST client of the registry with a bearer token. JSON answers are validated with the
 * `@skills/contracts` schemas; every failure is a `RegistryError`.
 */
export class RegistryClient {
  private readonly base: string;

  constructor(
    private readonly conn: Connection,
    private readonly fetchFn: typeof fetch,
  ) {
    this.base = conn.url.replace(/\/+$/, '');
  }

  private async send(
    method: 'GET' | 'POST' | 'PUT',
    path: string,
    body?: { json: unknown } | { form: FormData },
  ): Promise<Response> {
    const headers: Record<string, string> = {
      accept: 'application/json',
      authorization: `Bearer ${this.conn.token}`,
    };
    let payload: BodyInit | undefined;
    if (body && 'json' in body) {
      headers['content-type'] = 'application/json';
      payload = JSON.stringify(body.json);
    } else if (body) {
      payload = body.form;
    }
    let res: Response;
    try {
      res = await this.fetchFn(`${this.base}${path}`, {
        method,
        headers,
        ...(payload === undefined ? {} : { body: payload }),
      });
    } catch (e) {
      const reason = e instanceof Error ? e.message : String(e);
      throw new RegistryError(0, 'network_error', `cannot reach ${this.base}: ${reason}`);
    }
    if (!res.ok) throw await errorFrom(res);
    return res;
  }

  private async json<T>(res: Response, schema: ZodType<T>): Promise<T> {
    let data: unknown;
    try {
      data = await res.json();
    } catch {
      data = undefined;
    }
    const parsed = schema.safeParse(data);
    if (!parsed.success) {
      throw new RegistryError(res.status, 'bad_response', 'unexpected response from the registry');
    }
    return parsed.data;
  }

  private async get<T>(path: string, schema: ZodType<T>): Promise<T> {
    return this.json(await this.send('GET', path), schema);
  }

  me() {
    return this.get('/api/auth/me', MeResponse);
  }

  listSkills(q: { folder?: string; q?: string; status?: SkillStatusFilter }) {
    const params = new URLSearchParams();
    if (q.status !== undefined) params.set('status', q.status);
    if (q.folder !== undefined) params.set('folder', q.folder);
    if (q.q !== undefined) params.set('q', q.q);
    const query = params.size > 0 ? `?${params}` : '';
    return this.get(`/api/skills${query}`, SkillSummary.array());
  }

  /** `null` when the skill (or that version) does not exist. */
  async getSkill(slug: string, version?: number): Promise<SkillView | null> {
    const query = version === undefined ? '' : `?version=${version}`;
    try {
      return await this.get(`${skillPath(slug)}${query}`, SkillView);
    } catch (e) {
      if (e instanceof RegistryError && e.status === 404) return null;
      throw e;
    }
  }

  async getFile(slug: string, path: string, version: number): Promise<Uint8Array> {
    const encoded = path.split('/').map(encodeURIComponent).join('/');
    const res = await this.send('GET', `${skillPath(slug)}/files/${encoded}?version=${version}`);
    return new Uint8Array(await res.arrayBuffer());
  }

  history(slug: string) {
    return this.get(`${skillPath(slug)}/history`, VersionSummary.array());
  }

  listFolders(status: FolderStatusFilter) {
    return this.get(`/api/folders?status=${status}`, FolderSummary.array());
  }

  async createFolder(f: { slug: string; name: string; description: string }) {
    return this.json(await this.send('POST', '/api/folders', { json: f }), FolderRef);
  }

  async createSkill(p: {
    slug: string;
    folder: string;
    files: Map<string, Uint8Array>;
    message: string;
    source: SourceFields | null;
  }) {
    const form = new FormData();
    form.append('slug', p.slug);
    form.append('folder', p.folder);
    form.append('message', p.message);
    if (p.source !== null) {
      form.append('sourceHost', p.source.host);
      form.append('sourceRepo', p.source.repo);
      form.append('sourcePath', p.source.path);
      if (p.source.ref !== null) form.append('sourceRef', p.source.ref);
      form.append('sourceCommit', p.source.commit);
    }
    appendFiles(form, p.files);
    return this.json(await this.send('POST', '/api/skills', { form }), VersionRef);
  }

  /** A new version made of exactly `files` (nothing is kept from the base version). */
  async publishVersion(
    slug: string,
    p: {
      baseVersion: number;
      files: Map<string, Uint8Array>;
      message: string;
      sourceCommit: string | null;
    },
  ) {
    const form = new FormData();
    form.append('baseVersion', String(p.baseVersion));
    form.append('message', p.message);
    form.append('keep', '[]');
    if (p.sourceCommit !== null) form.append('sourceCommit', p.sourceCommit);
    appendFiles(form, p.files);
    return this.json(await this.send('PUT', skillPath(slug), { form }), VersionRef);
  }
}

function skillPath(slug: string): string {
  return `/api/skills/${encodeURIComponent(slug)}`;
}

async function errorFrom(res: Response): Promise<RegistryError> {
  let body: unknown;
  try {
    body = await res.json();
  } catch {
    body = undefined;
  }
  const parsed = ErrorBody.safeParse(body);
  return parsed.success
    ? new RegistryError(res.status, parsed.data.error.code, parsed.data.error.message)
    : new RegistryError(
        res.status,
        `http_${res.status}`,
        `the registry answered HTTP ${res.status}`,
      );
}
