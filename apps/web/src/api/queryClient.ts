import { QueryClient } from '@tanstack/react-query';
import { isApiError } from './errors.ts';

/** A 4xx answer will not change on retry; network errors and 5xx get up to 3 retries. */
function shouldRetry(failureCount: number, error: unknown): boolean {
  return failureCount < 3 && !(isApiError(error) && error.status >= 400 && error.status < 500);
}

/** The app's QueryClient. */
export function createQueryClient(): QueryClient {
  return new QueryClient({ defaultOptions: { queries: { retry: shouldRetry } } });
}
