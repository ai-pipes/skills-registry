import { screen, waitFor, within } from '@testing-library/react';
import { delay, http, HttpResponse } from 'msw';
import { beforeEach, describe, expect, it } from 'vite-plus/test';
import { z } from 'zod';
import { api } from '@/api/client.ts';
import { adminMe, memberMe } from '../../test/fixtures.ts';
import { errorResponse, server } from '../../test/msw/handlers.ts';
import { renderWithApp } from '../../test/setup.ts';
import { routes } from './routes.tsx';

// The skills pages load data: an empty registry, every other skill unknown.
function skillsHandlers() {
  server.use(
    http.get('/api/skills', () => HttpResponse.json([])),
    http.get('/api/skills/:slug', () => errorResponse(404, 'skill_not_found')),
  );
}

// While POST /logout is pending (10 ms), other calls are in flight and come back 401 after
// `ms` ms: some during the logout request, some after we reach /login.
async function logoutWith401sAfter(ms: number) {
  const inFlight: Promise<unknown>[] = [];
  skillsHandlers();
  server.use(
    http.post('/api/auth/logout', async () => {
      server.use(
        http.get('/api/skills', async () => {
          await delay(ms);
          return errorResponse(401, 'unauthenticated');
        }),
        http.get('/api/auth/me', async () => {
          await delay(ms);
          return errorResponse(401, 'unauthenticated');
        }),
      );
      inFlight.push(api.get('/api/skills', z.unknown()).catch(() => {}));
      await delay(10);
      return new HttpResponse(null, { status: 204 });
    }),
  );
  const { user, router, unmount } = renderWithApp(routes, { route: '/skills' });
  await user.click(await screen.findByRole('button', { name: 'admin' }));
  await user.click(await screen.findByRole('menuitem', { name: 'Sign out' }));
  await waitFor(() => expect(router.state.location.pathname).toBe('/login'));
  await Promise.all(inFlight);
  await delay(5);
  expect(router.state.location.pathname + router.state.location.search).toBe('/login');
  expect(await screen.findByRole('button', { name: 'Sign in' })).toBeTruthy();
  unmount();
  server.resetHandlers();
}

describe('app shell', () => {
  beforeEach(skillsHandlers);

  it('/ redirects to /skills', async () => {
    const { router } = renderWithApp(routes, { route: '/' });
    await waitFor(() => expect(router.state.location.pathname).toBe('/skills'));
    expect(await screen.findByRole('heading', { level: 1, name: 'Skills' })).toBeTruthy();
  });

  it('an admin sees every section, the current one marked active', async () => {
    renderWithApp(routes, { route: '/tokens' });
    const nav = await screen.findByRole('navigation', { name: 'Navigation' });
    for (const name of ['Skills', 'Folders', 'Tokens', 'Users']) {
      expect(within(nav).getByRole('link', { name })).toBeTruthy();
    }
    expect(within(nav).getByRole('link', { name: 'Tokens' }).getAttribute('aria-current')).toBe(
      'page',
    );
    expect(
      within(nav).getByRole('link', { name: 'Skills' }).getAttribute('aria-current'),
    ).toBeNull();
  });

  it('"Folders" is active on /folders', async () => {
    renderWithApp(routes, { route: '/folders' });
    const nav = await screen.findByRole('navigation', { name: 'Navigation' });
    expect(within(nav).getByRole('link', { name: 'Folders' }).getAttribute('aria-current')).toBe(
      'page',
    );
  });

  it.each([
    ['/skills', 'Skills'],
    ['/skills/a', 'Skill not found'],
    ['/tokens', 'Tokens'],
    ['/users', 'Users'],
    ['/skills/new', 'New skill'],
    ['/skills/a/edit', 'Skill not found'],
  ])('route %s shows its page', async (route, heading) => {
    renderWithApp(routes, { route });
    expect(await screen.findByRole('heading', { name: heading })).toBeTruthy();
  });

  it('a member does not see "Users" and gets "Access denied" on /users', async () => {
    renderWithApp(routes, { route: '/users', me: memberMe });
    const nav = await screen.findByRole('navigation', { name: 'Navigation' });
    expect(within(nav).queryByRole('link', { name: 'Users' })).toBeNull();
    expect(screen.getByText('Access denied')).toBeTruthy();
    expect(screen.queryByText('Coming soon')).toBeNull();
  });

  it('"Sign out" logs out and goes to /login', async () => {
    let loggedOut = false;
    server.use(
      http.post('/api/auth/logout', () => {
        loggedOut = true;
        return new HttpResponse(null, { status: 204 });
      }),
    );
    const { user, router } = renderWithApp(routes, { route: '/skills' });
    await user.click(await screen.findByRole('button', { name: 'admin' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Sign out' }));
    await waitFor(() => expect(router.state.location.pathname).toBe('/login'));
    expect(loggedOut).toBe(true);
    expect(router.state.location.search).toBe('');
    expect(await screen.findByRole('button', { name: 'Sign in' })).toBeTruthy();
  });

  it('401s that land during or after logout never add ?next= (20 timings)', async () => {
    // Sequential on purpose: each run renders its own app.
    await Array.from({ length: 20 }, (_, ms) => ms).reduce<Promise<void>>(
      (previous, ms) => previous.then(() => logoutWith401sAfter(ms)),
      Promise.resolve(),
    );
  });

  it('logout of an already expired session (401) counts as success', async () => {
    server.use(http.post('/api/auth/logout', () => errorResponse(401, 'unauthenticated')));
    const { user, router } = renderWithApp(routes, { route: '/tokens' });
    await user.click(await screen.findByRole('button', { name: 'admin' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Sign out' }));
    await waitFor(() => expect(router.state.location.pathname).toBe('/login'));
    expect(router.state.location.search).toBe('');
    expect(await screen.findByRole('button', { name: 'Sign in' })).toBeTruthy();
    expect(screen.queryByText('Server error (HTTP 401)')).toBeNull();
  });

  it.each([
    ['500', () => errorResponse(500, 'internal')],
    ['a network error', () => HttpResponse.error()],
  ])('a logout that fails with %s keeps the session and says so', async (_, answer) => {
    server.use(http.post('/api/auth/logout', answer));
    const { user, router } = renderWithApp(routes, { route: '/skills' });
    const menu = await screen.findByRole('button', { name: 'admin' });
    let meCalls = 0;
    server.use(
      http.get('/api/auth/me', () => {
        meCalls += 1;
        return HttpResponse.json(adminMe);
      }),
    );
    await user.click(menu);
    await user.click(await screen.findByRole('menuitem', { name: 'Sign out' }));
    // an error toast is announced assertively
    expect((await screen.findByRole('alert')).textContent).toBe(
      'Could not sign out. Check your connection and try again.',
    );
    await delay(20);
    expect(router.state.location.pathname + router.state.location.search).toBe('/skills');
    expect(screen.getByRole('button', { name: 'admin' })).toBeTruthy();
    expect(meCalls).toBe(1); // /me was re-fetched to show the real state
  });

  it('on narrow screens the navigation opens in a sheet and closes on navigation', async () => {
    const { user, router } = renderWithApp(routes, { route: '/skills' });
    await user.click(await screen.findByRole('button', { name: 'Open menu' }));
    const sheet = await screen.findByRole('dialog');
    await user.click(within(sheet).getByRole('link', { name: 'Tokens' }));
    await waitFor(() => expect(router.state.location.pathname).toBe('/tokens'));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });
});
