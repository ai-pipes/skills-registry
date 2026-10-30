/** A recorded request of a fake `fetch`. */
export type Recorded = { method: string; url: string; headers: Headers; body: unknown };

/** The multipart body of a recorded request. */
export function formOf(r: Recorded | undefined): FormData {
  if (!(r?.body instanceof FormData)) throw new Error('not a multipart request');
  return r.body;
}

export const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

/**
 * A fake `fetch` that records every request and answers with `handler`. Form bodies are recorded
 * as `FormData`, JSON bodies parsed.
 */
export function recordingFetch(handler: (req: Recorded) => Response | Promise<Response>): {
  fetch: typeof fetch;
  requests: Recorded[];
} {
  const requests: Recorded[] = [];
  const fetchFn = async (input: string | URL | Request, init?: RequestInit) => {
    const req = new Request(input, init);
    const type = req.headers.get('content-type') ?? '';
    let body: unknown;
    if (type.startsWith('multipart/form-data')) body = await req.formData();
    else if (type.startsWith('application/json')) body = await req.json();
    const recorded = { method: req.method, url: req.url, headers: req.headers, body };
    requests.push(recorded);
    return handler(recorded);
  };
  return { fetch: fetchFn, requests };
}

export function skillSummary(slug: string, over: Record<string, unknown> = {}) {
  return {
    slug,
    name: slug,
    description: `About ${slug}`,
    status: 'active',
    folder: { slug: 'design', name: 'Design' },
    version: 1,
    updatedAt: '2026-10-29T10:00:00.000Z',
    ...over,
  };
}

export function skillView(slug: string, over: Record<string, unknown> = {}) {
  return {
    ...skillSummary(slug),
    skillMd: `---\nname: ${slug}\ndescription: About ${slug}\n---\n`,
    // As the server sends it: SKILL.md is not among `files`.
    files: [],
    source: null,
    sourceCommit: null,
    skillMdSha256: '0'.repeat(64),
    ...over,
  };
}
