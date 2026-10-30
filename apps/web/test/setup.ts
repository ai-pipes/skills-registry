// Setup for the `web` test project (jsdom): polyfills the browser APIs the Base UI primitives
// under shadcn need, runs the shared msw server, and provides `renderWithApp`.
import { CSPProvider } from '@base-ui/react/csp-provider';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, configure, render } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import type { MeResponse } from '@skills/contracts';
import { createElement, type ReactElement } from 'react';
import { createMemoryRouter, RouterProvider, type RouteObject } from 'react-router';
import { afterAll, afterEach, beforeAll } from 'vite-plus/test';
import { Toaster } from '@/components/Toaster.tsx';
import { adminMe } from './fixtures.ts';
import { meHandler, server } from './msw/handlers.ts';

// The first render of a lazy route can take over the default 1 s under load.
configure({ asyncUtilTimeout: 3000 });

// --- jsdom polyfills -------------------------------------------------------------------------

if (!('ResizeObserver' in globalThis)) {
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
}

if (typeof window.matchMedia !== 'function') {
  window.matchMedia = (query: string): MediaQueryList => ({
    matches: false,
    media: query,
    onchange: null,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => false,
  });
}

const elementStubs = {
  hasPointerCapture: () => false,
  setPointerCapture: () => {},
  releasePointerCapture: () => {},
  scrollIntoView: () => {},
  getAnimations: () => [],
};
for (const [name, value] of Object.entries(elementStubs)) {
  if (!(name in Element.prototype)) {
    Object.defineProperty(Element.prototype, name, { value, writable: true, configurable: true });
  }
}

// --- msw -------------------------------------------------------------------------------------

beforeAll(() => server.listen({ onUnhandledFrame: 'error' }));
afterEach(() => {
  cleanup(); // toasts live in <Toaster />'s provider, so unmounting clears them
  server.resetHandlers();
});
afterAll(() => server.close());

// --- rendering -------------------------------------------------------------------------------

export interface RenderOptions {
  /** Initial location of the in-memory router. Default `/`. */
  route?: string;
  /** Answer of `GET /api/auth/me`; `null` means signed out. Default: an admin. */
  me?: MeResponse | null;
  /**
   * Route pattern the single `ui` element is mounted at, e.g. `/skills/:slug` so the page gets
   * `useParams()`. Default `*` (every path). Ignored when `ui` is a routes table.
   */
  path?: string;
}

/**
 * Renders `ui` the way the app does: inside Base UI's `CSPProvider` (no inline <style>), a
 * `QueryClientProvider` (no retries, so errors
 * surface at once), a memory data router at `route` (so `useBlocker` works), with the
 * `<Toaster />`. `ui` is either one element, mounted at `path` (default `*`; pass e.g.
 * `path: '/skills/:slug'` for route params), or a routes table such as the app's `routes`.
 * The returned `router` exposes `router.state.location`.
 */
export function renderWithApp(
  ui: ReactElement | RouteObject[],
  { route = '/', me = adminMe, path = '*' }: RenderOptions = {},
) {
  server.use(meHandler(me));
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const user = userEvent.setup();
  const routes = Array.isArray(ui) ? ui : [{ path, element: ui }];
  const router = createMemoryRouter(routes, { initialEntries: [route] });
  const result = render(
    createElement(
      CSPProvider,
      { disableStyleElements: true },
      createElement(
        QueryClientProvider,
        { client: queryClient },
        createElement(RouterProvider, { router }),
        createElement(Toaster),
      ),
    ),
  );
  return { ...result, queryClient, user, router };
}
