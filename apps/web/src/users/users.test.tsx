import { screen, waitFor, within } from '@testing-library/react';
import { CreateUserRequest, SetDisabledRequest, type UserSummary } from '@skills/contracts';
import { http, HttpResponse } from 'msw';
import { describe, expect, it } from 'vite-plus/test';
import { routes } from '@/app/routes.tsx';
import { adminMe, adminUser, aliceUser, bobUser, memberMe } from '../../test/fixtures.ts';
import { authConfigHandler, errorResponse, server } from '../../test/msw/handlers.ts';
import { renderWithApp } from '../../test/setup.ts';

const admin = adminUser;
const alice = aliceUser;
const bob = bobUser;

type Call = { method: string; path: string; body: unknown };

/** In-memory `/api/users`; records every mutation. */
function usersApi(initial: UserSummary[]) {
  const list = initial.map((u) => structuredClone(u));
  const calls: Call[] = [];
  server.use(
    http.get('/api/users', () => HttpResponse.json(list)),
    http.post('/api/users', async ({ request }) => {
      const body = CreateUserRequest.parse(await request.json());
      calls.push({ method: 'POST', path: '/api/users', body });
      if (list.some((u) => u.login === body.login)) {
        return errorResponse(409, 'user_exists');
      }
      const id = '44444444-4444-4444-8444-444444444444';
      list.push({ ...alice, id, login: body.login, role: body.role });
      return HttpResponse.json({ id }, { status: 201 });
    }),
    http.post('/api/users/:id/:action', async ({ request, params }) => {
      const body: unknown = await request.json();
      calls.push({
        method: 'POST',
        path: `/${String(params['action'])}/${String(params['id'])}`,
        body,
      });
      if (params['action'] === 'disable') {
        const { disabled } = SetDisabledRequest.parse(body);
        const found = list.find((u) => u.id === params['id']);
        if (found) found.disabled = disabled;
      }
      return new HttpResponse(null, { status: 204 });
    }),
  );
  return calls;
}

function buttonOf(el: HTMLElement): HTMLButtonElement {
  if (!(el instanceof HTMLButtonElement)) throw new Error('not a button');
  return el;
}

function rowOf(login: string) {
  const cell = screen.getAllByText(login).find((el) => el.closest('tr'));
  const tr = cell?.closest('tr');
  if (!tr) throw new Error(`no row for ${login}`);
  return within(tr);
}

describe('users page', () => {
  it('lists users with role and status; disabling yourself is not possible', async () => {
    usersApi([admin, alice, bob]);
    renderWithApp(routes, { route: '/users', me: adminMe });
    await screen.findByRole('heading', { name: 'Users' });
    await screen.findByText('alice');
    expect(rowOf('admin').getByText('Administrator')).toBeTruthy();
    expect(rowOf('alice').getByText('Member')).toBeTruthy();
    expect(rowOf('bob').getByText('Disabled')).toBeTruthy();
    const self = buttonOf(rowOf('admin').getByRole('button', { name: 'Disable' }));
    expect(self.disabled).toBe(true);
    expect(self.getAttribute('aria-describedby')).toBeTruthy();
    const hint = document.getElementById(self.getAttribute('aria-describedby') ?? '');
    expect(hint?.textContent).toBe('You cannot disable yourself');
    expect(buttonOf(rowOf('alice').getByRole('button', { name: 'Disable' })).disabled).toBe(false);
    expect(rowOf('bob').getByRole('button', { name: 'Enable' })).toBeTruthy();
  });

  it('"Add" validates the password length before any request, then creates', async () => {
    const calls = usersApi([admin]);
    const { user } = renderWithApp(routes, { route: '/users', me: adminMe });
    await screen.findByText('admin', { selector: 'td *, td' });
    await user.click(screen.getByRole('button', { name: 'Add' }));
    const dialog = within(await screen.findByRole('dialog'));
    await user.type(dialog.getByLabelText('Username'), 'carol');
    await user.type(dialog.getByLabelText('Password'), 'short-pass1');
    await user.click(dialog.getByRole('button', { name: 'Add' }));
    expect(await dialog.findByText('Password must be at least 12 characters')).toBeTruthy();
    expect(calls).toEqual([]);

    await user.type(dialog.getByLabelText('Password'), '2');
    await user.click(dialog.getByRole('combobox', { name: 'Role' }));
    await user.click(await screen.findByRole('option', { name: 'Administrator' }));
    await user.click(dialog.getByRole('button', { name: 'Add' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(calls).toEqual([
      {
        method: 'POST',
        path: '/api/users',
        body: { login: 'carol', password: 'short-pass12', role: 'admin' },
      },
    ]);
    expect(await screen.findByText('User added')).toBeTruthy();
    expect(rowOf('carol').getByText('Administrator')).toBeTruthy();
  });

  it('a taken login is shown under the field', async () => {
    usersApi([admin, alice]);
    const { user } = renderWithApp(routes, { route: '/users', me: adminMe });
    await screen.findByText('alice');
    await user.click(screen.getByRole('button', { name: 'Add' }));
    const dialog = within(await screen.findByRole('dialog'));
    await user.type(dialog.getByLabelText('Username'), 'alice');
    await user.type(dialog.getByLabelText('Password'), 'long-enough-pass');
    await user.click(dialog.getByRole('button', { name: 'Add' }));
    expect(await dialog.findByText('This username is already taken')).toBeTruthy();
  });

  it('"Reset password" sends the new password', async () => {
    const calls = usersApi([admin, alice]);
    const { user } = renderWithApp(routes, { route: '/users', me: adminMe });
    await screen.findByText('alice');
    await user.click(rowOf('alice').getByRole('button', { name: 'Reset password' }));
    const dialog = within(await screen.findByRole('dialog'));
    expect(dialog.getByText('New password for alice')).toBeTruthy();
    await user.type(dialog.getByLabelText('Password'), 'short');
    await user.click(dialog.getByRole('button', { name: 'Save' }));
    expect(await dialog.findByText('Password must be at least 12 characters')).toBeTruthy();
    expect(calls).toEqual([]);
    await user.type(dialog.getByLabelText('Password'), '-but-now-long');
    await user.click(dialog.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(calls).toEqual([
      { method: 'POST', path: `/password/${alice.id}`, body: { password: 'short-but-now-long' } },
    ]);
    expect(await screen.findByText('Password changed')).toBeTruthy();
  });

  it('"Disable" and "Enable" ask first, then toggle', async () => {
    const calls = usersApi([admin, alice, bob]);
    const { user } = renderWithApp(routes, { route: '/users', me: adminMe });
    await screen.findByText('alice');
    await user.click(rowOf('alice').getByRole('button', { name: 'Disable' }));
    const confirm = within(await screen.findByRole('alertdialog'));
    expect(confirm.getByText('Disable alice?')).toBeTruthy();
    await user.click(confirm.getByRole('button', { name: 'Disable' }));
    await waitFor(() => expect(rowOf('alice').getByText('Disabled')).toBeTruthy());

    await user.click(rowOf('bob').getByRole('button', { name: 'Enable' }));
    const again = within(await screen.findByRole('alertdialog'));
    await user.click(again.getByRole('button', { name: 'Enable' }));
    await waitFor(() => expect(rowOf('bob').getByText('Active')).toBeTruthy());
    expect(calls).toEqual([
      { method: 'POST', path: `/disable/${alice.id}`, body: { disabled: true } },
      { method: 'POST', path: `/disable/${bob.id}`, body: { disabled: false } },
    ]);
  });

  it('shows email, the SSO badge and the last sign-in', async () => {
    usersApi([admin, alice, bob]);
    renderWithApp(routes, { route: '/users', me: adminMe });
    await screen.findByText('alice');
    expect(rowOf('alice').getByText('alice@example.com')).toBeTruthy();
    expect(rowOf('alice').getByText('SSO')).toBeTruthy();
    expect(rowOf('admin').queryByText('SSO')).toBeNull();
    expect(rowOf('bob').getByText('Never')).toBeTruthy();
    const last = rowOf('alice')
      .getAllByRole('time')
      .find((el) => el.getAttribute('dateTime') === alice.lastLoginAt);
    expect(last?.getAttribute('title')).toBeTruthy();
    expect(screen.queryByText(/identity provider/)).toBeNull();
  });

  it('with SSO there is no "Add" and no "Reset password", and a note explains why', async () => {
    server.use(authConfigHandler('sso'));
    const calls = usersApi([admin, alice, bob]);
    const { user } = renderWithApp(routes, { route: '/users', me: adminMe });
    await screen.findByText('alice');
    expect(
      await screen.findByText(
        'People are added and their roles managed in the identity provider: membership in the admin and member groups decides who signs in and as what.',
      ),
    ).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Add' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Reset password' })).toBeNull();
    expect(rowOf('alice').getByText('SSO')).toBeTruthy();

    await user.click(rowOf('alice').getByRole('button', { name: 'Disable' }));
    const confirm = within(await screen.findByRole('alertdialog'));
    await user.click(confirm.getByRole('button', { name: 'Disable' }));
    await waitFor(() => expect(rowOf('alice').getByText('Disabled')).toBeTruthy());
    expect(calls).toEqual([
      { method: 'POST', path: `/disable/${alice.id}`, body: { disabled: true } },
    ]);
  });

  it('a member is not let in', async () => {
    renderWithApp(routes, { route: '/users', me: memberMe });
    expect(await screen.findByText('Access denied')).toBeTruthy();
  });
});
