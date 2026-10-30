import { SkillSummary } from '@skills/contracts';
import { http, HttpResponse } from 'msw';
import { afterEach, describe, expect, it, vi } from 'vite-plus/test';
import { z } from 'zod';
import { skillSummary } from '../../test/fixtures.ts';
import { errorResponse, server } from '../../test/msw/handlers.ts';
import { api, filePath, onUnauthorized } from './client.ts';
import { ApiError, isApiError } from './errors.ts';

const SkillList = z.array(SkillSummary);

async function caught(promise: Promise<unknown>): Promise<ApiError> {
  try {
    await promise;
  } catch (e) {
    if (isApiError(e)) return e;
    throw e;
  }
  throw new Error('expected the call to fail');
}

describe('api client', () => {
  const unsubscribe: Array<() => void> = [];
  afterEach(() => {
    for (const off of unsubscribe.splice(0)) off();
  });

  it('get validates the response with the schema and returns the data', async () => {
    server.use(http.get('/api/skills', () => HttpResponse.json([skillSummary])));
    await expect(api.get('/api/skills', SkillList)).resolves.toEqual([skillSummary]);
  });

  it('a response that fails the schema is a bad_response error', async () => {
    server.use(http.get('/api/skills', () => HttpResponse.json([{ slug: 1 }])));
    const error = await caught(api.get('/api/skills', SkillList));
    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({ status: 200, code: 'bad_response' });
  });

  it('a non-2xx ErrorBody becomes ApiError with its status and code', async () => {
    server.use(
      http.put('/api/skills/a', () => errorResponse(409, 'version_conflict', 'stale base')),
    );
    const error = await caught(api.put('/api/skills/a', { baseVersion: 1 }));
    expect(error).toMatchObject({ status: 409, code: 'version_conflict', message: 'stale base' });
  });

  it('a 429 carries Retry-After as retryAfterSec', async () => {
    server.use(
      http.post('/api/auth/login', () => {
        const res = errorResponse(429, 'rate_limited');
        res.headers.set('Retry-After', '300');
        return res;
      }),
    );
    const error = await caught(api.post('/api/auth/login', { login: 'a', password: 'b' }));
    expect(error).toMatchObject({ status: 429, code: 'rate_limited', retryAfterSec: 300 });
  });

  it('an error without Retry-After has no retryAfterSec', async () => {
    server.use(http.put('/api/skills/a', () => errorResponse(409, 'version_conflict')));
    const error = await caught(api.put('/api/skills/a', { baseVersion: 1 }));
    expect(error.retryAfterSec).toBeUndefined();
  });

  it('a non-JSON error body becomes http_<status>', async () => {
    server.use(http.get('/api/skills', () => new HttpResponse('gateway down', { status: 502 })));
    const error = await caught(api.get('/api/skills', SkillList));
    expect(error).toMatchObject({ status: 502, code: 'http_502' });
  });

  it('401 notifies the onUnauthorized subscribers', async () => {
    const listener = vi.fn();
    unsubscribe.push(onUnauthorized(listener));
    server.use(http.get('/api/skills', () => errorResponse(401, 'unauthenticated')));
    const error = await caught(api.get('/api/skills', SkillList));
    expect(error).toMatchObject({ status: 401, code: 'unauthenticated' });
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('sends JSON bodies with same-origin credentials', async () => {
    let seen: { body: unknown; type: string | null; credentials: string } | undefined;
    server.use(
      http.post('/api/tokens', async ({ request }) => {
        seen = {
          body: await request.json(),
          type: request.headers.get('content-type'),
          credentials: request.credentials,
        };
        return new HttpResponse(null, { status: 204 });
      }),
    );
    await expect(api.post('/api/tokens', { name: 'ci' })).resolves.toBeUndefined();
    expect(seen).toEqual({
      body: { name: 'ci' },
      type: 'application/json',
      credentials: 'same-origin',
    });
  });

  it('upload sends multipart form data and validates the answer', async () => {
    // In jsdom the part's file name does not survive Node's fetch (it arrives as `blob`), so
    // tests assert on field names and contents, which is what the server reads.
    let fields: Record<string, string> = {};
    server.use(
      http.post('/api/skills', async ({ request }) => {
        const form = await request.formData();
        const slug = form.get('slug');
        const part = form.get('SKILL.md');
        fields = {
          slug: typeof slug === 'string' ? slug : '',
          'SKILL.md': part !== null && typeof part !== 'string' ? await part.text() : '',
        };
        return HttpResponse.json(skillSummary);
      }),
    );
    const form = new FormData();
    form.set('slug', 'demo');
    form.set('SKILL.md', new File(['# demo'], 'SKILL.md'));
    await expect(api.upload('POST', '/api/skills', form, SkillSummary)).resolves.toEqual(
      skillSummary,
    );
    expect(fields).toEqual({ slug: 'demo', 'SKILL.md': '# demo' });
  });

  it('delete resolves on 204', async () => {
    server.use(http.delete('/api/tokens/t1', () => new HttpResponse(null, { status: 204 })));
    await expect(api.delete('/api/tokens/t1')).resolves.toBeUndefined();
  });

  it('a request that does not reach the server is a network_error', async () => {
    server.use(http.get('/api/skills', () => HttpResponse.error()));
    const error = await caught(api.get('/api/skills', SkillList));
    expect(error).toMatchObject({ status: 0, code: 'network_error' });
  });
});

describe('filePath', () => {
  it('encodes the file path segment by segment', () => {
    // A non-ASCII (Cyrillic) name with a space on purpose: both must be percent-encoded.
    expect(filePath('a', 'references/Мой файл.md')).toBe(
      '/api/skills/a/files/references/%D0%9C%D0%BE%D0%B9%20%D1%84%D0%B0%D0%B9%D0%BB.md',
    );
  });
});
