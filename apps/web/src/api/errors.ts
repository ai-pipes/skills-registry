/**
 * A failed API call. `code` is the server's `ErrorBody.error.code` (e.g. `version_conflict`),
 * `http_<status>` when the error body is not an `ErrorBody`, `bad_response` when a 2xx body
 * does not match its contract schema, and `network_error` (status 0) when the request did not
 * reach the server. `retryAfterSec` is the `Retry-After` header of the answer, when present
 * (rate limiting).
 */
export class ApiError extends Error {
  override readonly name = 'ApiError';
  readonly status: number;
  readonly code: string;
  readonly retryAfterSec: number | undefined;

  constructor(status: number, code: string, message: string, retryAfterSec?: number) {
    super(message);
    this.status = status;
    this.code = code;
    this.retryAfterSec = retryAfterSec;
  }
}

export function isApiError(e: unknown): e is ApiError {
  return e instanceof ApiError;
}
