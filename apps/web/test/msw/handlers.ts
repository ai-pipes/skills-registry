import type { AuthMethod, ErrorBody, FolderSummary, MeResponse } from '@skills/contracts';
import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import { devopsFolder, generalFolder, oldFolder } from '../fixtures.ts';

/** `ErrorBody` JSON response, as the server sends for every non-2xx. */
export function errorResponse(status: number, code: string, message = code) {
  const body: ErrorBody = { error: { code, message } };
  return HttpResponse.json(body, { status });
}

/** `GET /api/auth/me`: the signed-in user, or 401 when `me` is null. */
export function meHandler(me: MeResponse | null) {
  return http.get('/api/auth/me', () =>
    me ? HttpResponse.json(me) : errorResponse(401, 'unauthenticated'),
  );
}

/** `GET /api/auth/config`: how people sign in (`password` by default). */
export function authConfigHandler(method: AuthMethod = 'password') {
  return http.get('/api/auth/config', () => HttpResponse.json({ method }));
}

/** `GET /api/folders?status=`: `folders` filtered by status (`active` by default, `all` keeps all). */
export function foldersHandler(
  folders: FolderSummary[] = [generalFolder, devopsFolder, oldFolder],
) {
  return http.get('/api/folders', ({ request }) => {
    const status = new URL(request.url).searchParams.get('status') ?? 'active';
    return HttpResponse.json(
      status === 'all' ? folders : folders.filter((f) => f.status === status),
    );
  });
}

/**
 * Default handlers: nobody is signed in, password sign-in. Tests add their own with
 * `server.use(...)`.
 */
const handlers = [meHandler(null), authConfigHandler(), foldersHandler()];

/** The msw server shared by all web tests (started in test/setup.ts). */
export const server = setupServer(...handlers);
