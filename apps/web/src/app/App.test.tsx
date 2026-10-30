import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it } from 'vite-plus/test';
import { adminMe } from '../../test/fixtures.ts';
import { meHandler, server } from '../../test/msw/handlers.ts';
import { App } from './App.tsx';

describe('App', () => {
  it('runs the routes on the browser router: / goes to /skills for a signed-in user', async () => {
    server.use(meHandler(adminMe));
    render(
      <QueryClientProvider client={new QueryClient()}>
        <App />
      </QueryClientProvider>,
    );
    expect(await screen.findByRole('navigation', { name: 'Navigation' })).toBeTruthy();
    await waitFor(() => expect(window.location.pathname).toBe('/skills'));
  });
});
