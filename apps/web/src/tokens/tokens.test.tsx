import { screen, waitFor, within } from '@testing-library/react';
import { CreateTokenRequest, type CreatedToken, type TokenSummary } from '@skills/contracts';
import { http, HttpResponse } from 'msw';
import { afterEach, describe, expect, it, vi } from 'vite-plus/test';
import { errorResponse, server } from '../../test/msw/handlers.ts';
import { renderWithApp } from '../../test/setup.ts';
import { TokensPage } from './TokensPage.tsx';

const laptop: TokenSummary = {
  id: '11111111-1111-4111-8111-111111111111',
  name: 'laptop',
  prefix: 'sk_abcd',
  createdAt: '2026-10-20T12:00:00.000Z',
  lastUsedAt: null,
  revokedAt: null,
};
const old: TokenSummary = {
  id: '22222222-2222-4222-8222-222222222222',
  name: 'old-ci',
  prefix: 'sk_efgh',
  createdAt: '2026-09-01T12:00:00.000Z',
  lastUsedAt: '2026-09-02T12:00:00.000Z',
  revokedAt: '2026-09-03T12:00:00.000Z',
};
const created: CreatedToken = {
  id: '33333333-3333-4333-8333-333333333333',
  prefix: 'sk_ijkl',
  token: 'sk_ijkl_secret_value',
  connectCommand:
    'claude mcp add --transport http skills http://localhost/mcp --header "Authorization: Bearer sk_ijkl_secret_value"',
};

/** In-memory `/api/tokens`; records created names and revoked ids. */
function tokensApi(initial: TokenSummary[]) {
  const list = initial.map((t) => structuredClone(t));
  const log = { created: [] as string[], revoked: [] as string[] };
  server.use(
    http.get('/api/tokens', () => HttpResponse.json(list)),
    http.post('/api/tokens', async ({ request }) => {
      const body = CreateTokenRequest.parse(await request.json());
      log.created.push(body.name);
      list.push({
        ...laptop,
        id: created.id,
        name: body.name,
        prefix: created.prefix,
      });
      return HttpResponse.json(created, { status: 201 });
    }),
    http.delete('/api/tokens/:id', ({ params }) => {
      log.revoked.push(String(params['id']));
      const token = list.find((t) => t.id === params['id']);
      if (token) token.revokedAt = '2026-10-28T12:00:00.000Z';
      return new HttpResponse(null, { status: 204 });
    }),
  );
  return log;
}

function rowOf(name: string) {
  const tr = screen.getByText(name).closest('tr');
  if (!tr) throw new Error(`no row for ${name}`);
  return within(tr);
}

afterEach(() => vi.restoreAllMocks());

function inputOf(el: HTMLElement): HTMLInputElement {
  if (!(el instanceof HTMLInputElement)) throw new Error('not an input');
  return el;
}

describe('tokens page', () => {
  it('lists name, prefix, created, last use and status', async () => {
    tokensApi([laptop, old]);
    renderWithApp(<TokensPage />, { route: '/tokens' });
    await screen.findByText('laptop');
    expect(rowOf('laptop').getByText('sk_abcd…')).toBeTruthy();
    expect(rowOf('laptop').getByText('never')).toBeTruthy();
    expect(rowOf('laptop').getByText('Active')).toBeTruthy();
    expect(rowOf('old-ci').getByText('Revoked')).toBeTruthy();
    expect(rowOf('old-ci').queryByRole('button', { name: 'Revoke' })).toBeNull();
  });

  it('a new token and its connect command are shown once', async () => {
    const log = tokensApi([]);
    const { user } = renderWithApp(<TokensPage />, { route: '/tokens' });
    await screen.findByText('No tokens yet');
    await user.click(screen.getByRole('button', { name: 'Create token' }));
    const dialog = within(await screen.findByRole('dialog'));
    await user.type(dialog.getByLabelText('Name'), 'laptop');
    await user.click(dialog.getByRole('button', { name: 'Create' }));

    expect(await dialog.findByText('The token is shown only once')).toBeTruthy();
    expect(inputOf(dialog.getByLabelText('Token')).value).toBe(created.token);
    expect(inputOf(dialog.getByLabelText('Connect command')).value).toBe(created.connectCommand);
    expect(log.created).toEqual(['laptop']);

    await user.click(dialog.getByRole('button', { name: 'Done' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(await screen.findByText('laptop')).toBeTruthy();
    expect(screen.queryByDisplayValue(created.token)).toBeNull();

    // Opening the dialog again starts from an empty form, not the old token.
    await user.click(screen.getByRole('button', { name: 'Create token' }));
    const again = within(await screen.findByRole('dialog'));
    expect(again.queryByText('The token is shown only once')).toBeNull();
    expect(screen.queryByDisplayValue(created.token)).toBeNull();
  });

  it('the plaintext token never sits in the MutationCache, open or after close', async () => {
    tokensApi([]);
    const { user, queryClient } = renderWithApp(<TokensPage />, { route: '/tokens' });
    const cachedWithToken = () =>
      queryClient
        .getMutationCache()
        .getAll()
        .filter((m) => JSON.stringify(m.state.data ?? null).includes(created.token));
    await screen.findByText('No tokens yet');
    await user.click(screen.getByRole('button', { name: 'Create token' }));
    const dialog = within(await screen.findByRole('dialog'));
    await user.type(dialog.getByLabelText('Name'), 'x');
    await user.click(dialog.getByRole('button', { name: 'Create' }));
    await dialog.findByText('The token is shown only once');
    expect(cachedWithToken()).toEqual([]);
    await user.click(dialog.getByRole('button', { name: 'Done' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(cachedWithToken()).toEqual([]);
  });

  it('an empty name is rejected before any request', async () => {
    const log = tokensApi([]);
    const { user } = renderWithApp(<TokensPage />, { route: '/tokens' });
    await screen.findByText('No tokens yet');
    await user.click(screen.getByRole('button', { name: 'Create token' }));
    const dialog = within(await screen.findByRole('dialog'));
    await user.click(dialog.getByRole('button', { name: 'Create' }));
    expect(await dialog.findByText('Enter a name')).toBeTruthy();
    expect(log.created).toEqual([]);
  });

  it('"Copy" writes the token to the clipboard', async () => {
    tokensApi([]);
    const { user } = renderWithApp(<TokensPage />, { route: '/tokens' });
    // user-event installs a clipboard stub on setup; spy on it.
    const writeText = vi.spyOn(navigator.clipboard, 'writeText').mockResolvedValue();
    await screen.findByText('No tokens yet');
    await user.click(screen.getByRole('button', { name: 'Create token' }));
    const dialog = within(await screen.findByRole('dialog'));
    await user.type(dialog.getByLabelText('Name'), 'x');
    await user.click(dialog.getByRole('button', { name: 'Create' }));
    await user.click(await dialog.findByRole('button', { name: 'Copy: Token' }));
    expect(writeText).toHaveBeenCalledWith(created.token);
    expect(await screen.findByText('Copied')).toBeTruthy();
  });

  it('when the clipboard refuses, the text is selected and a hint is shown', async () => {
    tokensApi([]);
    const { user } = renderWithApp(<TokensPage />, { route: '/tokens' });
    vi.spyOn(navigator.clipboard, 'writeText').mockRejectedValue(new Error('denied'));
    await screen.findByText('No tokens yet');
    await user.click(screen.getByRole('button', { name: 'Create token' }));
    const dialog = within(await screen.findByRole('dialog'));
    await user.type(dialog.getByLabelText('Name'), 'x');
    await user.click(dialog.getByRole('button', { name: 'Create' }));
    await user.click(await dialog.findByRole('button', { name: 'Copy: Connect command' }));
    expect(await dialog.findByText(/Could not copy/)).toBeTruthy();
    const field = inputOf(dialog.getByLabelText('Connect command'));
    expect(document.activeElement).toBe(field);
    expect((field.selectionEnd ?? 0) - (field.selectionStart ?? 0)).toBe(
      created.connectCommand.length,
    );
  });

  it('"Revoke" asks first, then revokes', async () => {
    const log = tokensApi([laptop]);
    const { user } = renderWithApp(<TokensPage />, { route: '/tokens' });
    await screen.findByText('laptop');
    await user.click(rowOf('laptop').getByRole('button', { name: 'Revoke' }));
    const dialog = within(await screen.findByRole('alertdialog'));
    expect(dialog.getByText('Revoke token?')).toBeTruthy();
    expect(log.revoked).toEqual([]);
    await user.click(dialog.getByRole('button', { name: 'Revoke' }));
    await waitFor(() => expect(rowOf('laptop').getByText('Revoked')).toBeTruthy());
    expect(log.revoked).toEqual([laptop.id]);
  });

  it('a failed list shows the page error', async () => {
    server.use(http.get('/api/tokens', () => errorResponse(500, 'internal')));
    renderWithApp(<TokensPage />, { route: '/tokens' });
    expect((await screen.findByRole('alert')).textContent).toContain('500');
  });
});
