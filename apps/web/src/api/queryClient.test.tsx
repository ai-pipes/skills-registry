import { QueryClientProvider, useQuery } from '@tanstack/react-query';
import { renderHook, waitFor } from '@testing-library/react';
import { http } from 'msw';
import type { ReactNode } from 'react';
import { describe, expect, it } from 'vite-plus/test';
import { errorResponse, server } from '../../test/msw/handlers.ts';
import { api } from './client.ts';
import { createQueryClient } from './queryClient.ts';
import { z } from 'zod';

function countingHandler(status: number, code: string) {
  const calls = { n: 0 };
  server.use(
    http.get('/api/probe', () => {
      calls.n += 1;
      return errorResponse(status, code);
    }),
  );
  return calls;
}

function probe() {
  const client = createQueryClient();
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  // retryDelay 0 keeps the default retry policy but skips the back-off wait.
  return renderHook(
    () =>
      useQuery({
        queryKey: ['probe'],
        queryFn: () => api.get('/api/probe', z.unknown()),
        retryDelay: 0,
      }),
    { wrapper },
  );
}

describe('createQueryClient', () => {
  it('does not retry a 4xx: a 404 fails after one request', async () => {
    const calls = countingHandler(404, 'skill_not_found');
    const { result } = probe();
    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(calls.n).toBe(1);
  });

  it('retries a 5xx up to 3 times', async () => {
    const calls = countingHandler(503, 'unavailable');
    const { result } = probe();
    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(calls.n).toBe(4);
  });
});
