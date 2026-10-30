import { ErrorBody } from '@skills/contracts';
import type { ZodType } from 'zod';
import { strings } from '../strings.ts';
import { ApiError } from './errors.ts';

type Method = 'GET' | 'POST' | 'PUT' | 'DELETE';

const unauthorizedListeners = new Set<() => void>();

/**
 * Subscribes to 401 answers of any API call (the session expired or never existed).
 * Returns the unsubscribe function.
 */
export function onUnauthorized(listener: () => void): () => void {
  unauthorizedListeners.add(listener);
  return () => unauthorizedListeners.delete(listener);
}

async function errorFrom(res: Response): Promise<ApiError> {
  let body: unknown;
  try {
    body = await res.json();
  } catch {
    body = undefined;
  }
  const parsed = ErrorBody.safeParse(body);
  const retryAfter = Number(res.headers.get('retry-after') ?? Number.NaN);
  const retryAfterSec = Number.isFinite(retryAfter) && retryAfter >= 0 ? retryAfter : undefined;
  return parsed.success
    ? new ApiError(res.status, parsed.data.error.code, parsed.data.error.message, retryAfterSec)
    : new ApiError(
        res.status,
        `http_${res.status}`,
        strings.errors.http(res.status),
        retryAfterSec,
      );
}

async function send(method: Method, path: string, body?: BodyInit, json = false) {
  const headers: Record<string, string> = { accept: 'application/json' };
  if (json) headers['content-type'] = 'application/json';
  let res: Response;
  try {
    // Same-origin only: the browser sets `Origin`, which the server checks against CSRF.
    res = await fetch(path, {
      method,
      headers,
      credentials: 'same-origin',
      ...(body === undefined ? {} : { body }),
    });
  } catch {
    throw new ApiError(0, 'network_error', strings.errors.network);
  }
  if (!res.ok) {
    if (res.status === 401) for (const listener of unauthorizedListeners) listener();
    throw await errorFrom(res);
  }
  return res;
}

async function parse<T>(res: Response, schema: ZodType<T>): Promise<T> {
  let data: unknown;
  try {
    data = await res.json();
  } catch {
    throw new ApiError(res.status, 'bad_response', strings.errors.badResponse);
  }
  const parsed = schema.safeParse(data);
  if (!parsed.success) throw new ApiError(res.status, 'bad_response', strings.errors.badResponse);
  return parsed.data;
}

function jsonBody(body: unknown): BodyInit | undefined {
  return body === undefined ? undefined : JSON.stringify(body);
}

async function withJson<T>(
  method: 'POST' | 'PUT',
  path: string,
  body: unknown,
  schema?: ZodType<T>,
): Promise<T | undefined> {
  const res = await send(method, path, jsonBody(body), body !== undefined);
  return schema ? parse(res, schema) : undefined;
}

function post<T>(path: string, body: unknown, schema: ZodType<T>): Promise<T>;
function post(path: string, body?: unknown): Promise<void>;
async function post<T>(path: string, body?: unknown, schema?: ZodType<T>) {
  return withJson('POST', path, body, schema);
}

function put<T>(path: string, body: unknown, schema: ZodType<T>): Promise<T>;
function put(path: string, body?: unknown): Promise<void>;
async function put<T>(path: string, body?: unknown, schema?: ZodType<T>) {
  return withJson('PUT', path, body, schema);
}

/**
 * Typed REST client. JSON answers are validated with the given `@skills/contracts` schema;
 * any failure is an `ApiError` (see errors.ts). Calls without a schema expect no body.
 */
export const api = {
  async get<T>(path: string, schema: ZodType<T>): Promise<T> {
    return parse(await send('GET', path), schema);
  },
  /** A text body as is (skill files); errors are `ApiError` like every other call. */
  async getText(path: string): Promise<string> {
    return (await send('GET', path)).text();
  },
  post,
  put,
  async delete(path: string): Promise<void> {
    await send('DELETE', path);
  },
  /** Multipart request; the browser sets the `multipart/form-data` boundary itself. */
  async upload<T>(
    method: 'POST' | 'PUT',
    path: string,
    form: FormData,
    schema: ZodType<T>,
  ): Promise<T> {
    return parse(await send(method, path, form), schema);
  },
};

/** URL of a skill file; the path is encoded segment by segment (`/` stays a separator). */
export function filePath(slug: string, path: string): string {
  const encoded = path.split('/').map(encodeURIComponent).join('/');
  return `/api/skills/${encodeURIComponent(slug)}/files/${encoded}`;
}
