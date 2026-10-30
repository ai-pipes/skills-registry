import type { Context } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { IdentityError } from '../../modules/identity/index.ts';
import { DomainError, type Result } from '../../shared-kernel/index.ts';

const STATUS: Record<string, ContentfulStatusCode> = {
  skill_not_found: 404,
  file_not_found: 404,
  version_not_found: 404,
  not_found: 404,
  version_conflict: 409,
  skill_exists: 409,
  skill_archived: 409,
  folder_not_found: 404,
  folder_exists: 409,
  folder_archived: 409,
  not_imported: 409,
  user_exists: 409,
  missing_skill_md: 422,
  name_mismatch: 422,
  duplicate_path: 422,
  weak_password: 422,
  limit_exceeded: 413,
  invalid_credentials: 401,
  invalid_token: 401,
  unauthenticated: 401,
  forbidden: 403,
  csrf: 403,
  locked: 429,
  rate_limited: 429,
};

function statusFor(code: string): ContentfulStatusCode {
  return STATUS[code] ?? (code.startsWith('invalid_') ? 422 : 400);
}

export function errorResponse(c: Context, code: string, message: string): Response {
  return c.json({ error: { code, message } }, statusFor(code));
}

/** JSON error response for a domain error; adds Retry-After for rate limiting. */
export function domainErrorResponse(c: Context, e: DomainError): Response {
  if (e instanceof IdentityError && e.retryAfterSec !== undefined) {
    c.header('Retry-After', String(Math.max(1, Math.ceil(e.retryAfterSec))));
  }
  return errorResponse(c, e.code, e.message);
}

/** Returns the value or throws the domain error, which `app.onError` turns into a response. */
export function unwrap<T, E extends DomainError>(r: Result<T, E>): T {
  if (!r.ok) throw r.error;
  return r.value;
}

export const invalidRequest = (message: string) => new DomainError('invalid_request', message);
