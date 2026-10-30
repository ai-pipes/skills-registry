import { screen, waitFor } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { describe, expect, it } from 'vite-plus/test';
import { z } from 'zod';
import { api } from '@/api/client.ts';
import { routes } from '@/app/routes.tsx';
import { adminMe } from '../../test/fixtures.ts';
import { errorResponse, meHandler, server } from '../../test/msw/handlers.ts';
import { renderWithApp } from '../../test/setup.ts';

/** Login answers 204 and, from then on, `/me` answers with the admin. */
const loginOk = () =>
  http.post('/api/auth/login', () => {
    server.use(meHandler(adminMe));
    return new HttpResponse(null, { status: 204 });
  });

async function submitLogin(user: ReturnType<typeof renderWithApp>['user']) {
  await user.type(await screen.findByLabelText('Username'), 'admin');
  await user.type(screen.getByLabelText('Password'), 'secret');
  await user.click(screen.getByRole('button', { name: 'Sign in' }));
}

const here = (router: ReturnType<typeof renderWithApp>['router']) =>
  router.state.location.pathname + router.state.location.search;

describe('login', () => {
  it('a wrong password shows the error and does not redirect', async () => {
    server.use(http.post('/api/auth/login', () => errorResponse(401, 'invalid_credentials')));
    const { user, router } = renderWithApp(routes, { route: '/login?next=/tokens', me: null });
    await submitLogin(user);
    expect(await screen.findByText('Invalid username or password')).toBeTruthy();
    expect(here(router)).toBe('/login?next=/tokens');
    expect(screen.getByLabelText('Username')).toBeTruthy();
  });

  it('429 shows the wait time in minutes from Retry-After', async () => {
    server.use(
      http.post('/api/auth/login', () => {
        const res = errorResponse(429, 'rate_limited');
        res.headers.set('Retry-After', '300');
        return res;
      }),
    );
    const { user } = renderWithApp(routes, { route: '/login', me: null });
    await submitLogin(user);
    expect(await screen.findByText('Too many attempts. Try again in 5 minutes.')).toBeTruthy();
  });

  it('a 204 login followed by 401 on /me means the cookie was not stored', async () => {
    server.use(http.post('/api/auth/login', () => new HttpResponse(null, { status: 204 })));
    const { user, router } = renderWithApp(routes, { route: '/login', me: null });
    await submitLogin(user);
    expect(
      await screen.findByText(
        'The browser did not store the session cookie. The server requires HTTPS (COOKIE_SECURE=true). Open the service over https:// or set COOKIE_SECURE=false on an internal network.',
      ),
    ).toBeTruthy();
    expect(router.state.location.pathname).toBe('/login');
  });

  it('after login returns to a relative ?next= path', async () => {
    server.use(loginOk());
    const { user, router } = renderWithApp(routes, { route: '/login?next=/tokens', me: null });
    await submitLogin(user);
    await waitFor(() => expect(router.state.location.pathname).toBe('/tokens'));
  });

  it.each(['//evil.com', 'https://evil.com', '/\\evil.com', '/\t/evil.com'])(
    'ignores ?next=%j and goes to /skills',
    async (next) => {
      server.use(loginOk());
      const { user, router } = renderWithApp(routes, {
        route: `/login?next=${encodeURIComponent(next)}`,
        me: null,
      });
      await submitLogin(user);
      await waitFor(() => expect(here(router)).toBe('/skills'));
    },
  );

  it('a signed-in user opening /login goes to the app', async () => {
    const { router } = renderWithApp(routes, { route: '/login' });
    await waitFor(() => expect(router.state.location.pathname).toBe('/skills'));
  });
});

describe('session', () => {
  it('a signed-out visit redirects to /login with the original path', async () => {
    const { router } = renderWithApp(routes, { route: '/skills/a/history?x=1', me: null });
    await screen.findByRole('button', { name: 'Sign in' });
    expect(router.state.location.pathname).toBe('/login');
    expect(new URLSearchParams(router.state.location.search).get('next')).toBe(
      '/skills/a/history?x=1',
    );
  });

  it('a 401 from any API call while signed in redirects to /login?next=', async () => {
    server.use(http.get('/api/skills', () => errorResponse(401, 'unauthenticated')));
    const { router } = renderWithApp(routes, { route: '/tokens' });
    await screen.findByRole('link', { name: 'Tokens' });
    server.use(meHandler(null)); // the session is gone on the server
    await expect(api.get('/api/skills', z.unknown())).rejects.toMatchObject({ status: 401 });
    await waitFor(() => expect(router.state.location.pathname).toBe('/login'));
    expect(new URLSearchParams(router.state.location.search).get('next')).toBe('/tokens');
    expect(await screen.findByRole('button', { name: 'Sign in' })).toBeTruthy();
  });
});
