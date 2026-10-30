import { screen } from '@testing-library/react';
import { http } from 'msw';
import { describe, expect, it } from 'vite-plus/test';
import { routes } from '@/app/routes.tsx';
import { authConfigHandler, errorResponse, server } from '../../test/msw/handlers.ts';
import { renderWithApp } from '../../test/setup.ts';

const ssoLink = () => screen.findByRole('link', { name: 'Sign in with SSO' });

describe('login page with single sign-on', () => {
  it('shows a hint and a link to the SSO login with the encoded ?next= as returnTo', async () => {
    server.use(authConfigHandler('sso'));
    renderWithApp(routes, {
      route: `/login?next=${encodeURIComponent('/skills/a b?x=1&y=2')}`,
      me: null,
    });
    const link = await ssoLink();
    expect(link.getAttribute('href')).toBe(
      `/api/auth/sso/login?returnTo=${encodeURIComponent('/skills/a b?x=1&y=2')}`,
    );
    expect(screen.getByRole('heading', { name: 'Sign in' })).toBeTruthy();
    expect(screen.getByText('Sign in with your organization account.')).toBeTruthy();
    expect(screen.queryByLabelText('Password')).toBeNull();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it.each(['//evil.com', 'https://evil.com', '/\\evil.com', '/\t/evil.com'])(
    'does not pass ?next=%j on: returnTo is /skills',
    async (next) => {
      server.use(authConfigHandler('sso'));
      renderWithApp(routes, { route: `/login?next=${encodeURIComponent(next)}`, me: null });
      expect((await ssoLink()).getAttribute('href')).toBe(
        `/api/auth/sso/login?returnTo=${encodeURIComponent('/skills')}`,
      );
    },
  );

  it.each([
    ['invalid_state', 'The sign-in has expired. Try again.'],
    ['not_allowed', 'Your account is not in an allowed group. Ask an administrator for access.'],
    ['disabled', 'Your account is disabled.'],
    ['idp_unavailable', 'The identity provider is unavailable. Try again later.'],
    ['internal', 'Something went wrong while signing in. Try again.'],
    ['something_else', 'Something went wrong while signing in. Try again.'],
    ['toString', 'Something went wrong while signing in. Try again.'],
  ])('?loginError=%s explains the failure', async (code, text) => {
    server.use(authConfigHandler('sso'));
    renderWithApp(routes, { route: `/login?loginError=${code}`, me: null });
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('Could not sign in');
    expect(alert.textContent).toContain(text);
    expect(await ssoLink()).toBeTruthy();
  });
});

describe('login page sign-in method', () => {
  it('password mode shows the form and no SSO link', async () => {
    renderWithApp(routes, { route: '/login', me: null });
    expect(await screen.findByLabelText('Password')).toBeTruthy();
    expect(screen.queryByRole('link', { name: 'Sign in with SSO' })).toBeNull();
  });

  it('while the method loads, shows the card without a form', async () => {
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    server.use(
      http.get('/api/auth/config', async () => {
        await gate;
        return errorResponse(503, 'unavailable');
      }),
    );
    renderWithApp(routes, { route: '/login', me: null });
    expect(await screen.findByRole('status', { name: 'Loading sign-in options' })).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Sign in' })).toBeTruthy();
    expect(screen.queryByLabelText('Password')).toBeNull();
    release?.();
    expect(await screen.findByLabelText('Password')).toBeTruthy();
  });

  it('falls back to the password form when the config request fails', async () => {
    server.use(http.get('/api/auth/config', () => errorResponse(500, 'internal')));
    renderWithApp(routes, { route: '/login', me: null });
    expect(await screen.findByLabelText('Password')).toBeTruthy();
    expect(screen.queryByRole('link', { name: 'Sign in with SSO' })).toBeNull();
  });
});
