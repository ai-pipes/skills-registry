import type { FileDiff, VersionSummary } from '@skills/contracts';
import { screen, waitFor } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { describe, expect, it } from 'vite-plus/test';
import { errorResponse, server } from '../../test/msw/handlers.ts';
import { renderWithApp } from '../../test/setup.ts';
import { DiffPage } from './DiffView.tsx';
import { HistoryPage } from './HistoryPage.tsx';

const v = (number: number, extra: Partial<VersionSummary> = {}): VersionSummary => ({
  number,
  authorId: 'u1',
  authorLogin: 'alice',
  message: `edit ${number}`,
  createdAt: '2026-10-01T10:00:00.000Z',
  restoredFrom: null,
  sourceCommit: null,
  ...extra,
});

function historyApi(versions: VersionSummary[]) {
  const state = { versions, bodies: [] as unknown[], historyCalls: 0 };
  server.use(
    http.get('/api/skills/:slug/history', () => {
      state.historyCalls += 1;
      return HttpResponse.json(state.versions);
    }),
  );
  return state;
}

const route = { route: '/skills/code-review/history', path: '/skills/:slug/history' };

describe('HistoryPage', () => {
  it('lists versions with author fallback and rollback marker', async () => {
    historyApi([v(3, { authorLogin: null, restoredFrom: 1 }), v(2), v(1)]);
    renderWithApp(<HistoryPage />, route);
    expect(await screen.findByText('deleted user')).toBeTruthy();
    expect(screen.getByText('rollback to v1')).toBeTruthy();
    expect(screen.getAllByRole('link', { name: 'Open' })[1]?.getAttribute('href')).toBe(
      '/skills/code-review?version=2',
    );
  });

  it('marks versions taken from GitHub', async () => {
    historyApi([v(2, { sourceCommit: 'a1b2c3d' + '0'.repeat(33) }), v(1)]);
    renderWithApp(<HistoryPage />, route);
    expect(await screen.findByText('from GitHub @ a1b2c3d')).toBeTruthy();
    expect(screen.getAllByText(/^from GitHub/)).toHaveLength(1);
  });

  it('compares two picked versions', async () => {
    historyApi([v(3), v(2), v(1)]);
    const { user, router } = renderWithApp(<HistoryPage />, route);
    await user.click(await screen.findByRole('checkbox', { name: 'Select version 3' }));
    await user.click(screen.getByRole('checkbox', { name: 'Select version 1' }));
    await user.click(screen.getByRole('button', { name: 'Compare' }));
    expect(router.state.location.pathname + router.state.location.search).toBe(
      '/skills/code-review/diff?from=1&to=3',
    );
  });

  it('rolls back with baseVersion = current, then refreshes history', async () => {
    const api = historyApi([v(3), v(2), v(1)]);
    server.use(
      http.post('/api/skills/:slug/rollback', async ({ request }) => {
        api.bodies.push(await request.json());
        api.versions = [v(4, { restoredFrom: 1 }), ...api.versions];
        return HttpResponse.json({ slug: 'code-review', version: 4 });
      }),
    );
    const { user } = renderWithApp(<HistoryPage />, route);
    const buttons = await screen.findAllByRole('button', { name: 'Roll back to this version' });
    await user.click(buttons[1]!); // v1 (v3 is current and has no button)
    await user.click(await screen.findByRole('button', { name: 'Roll back' }));
    await waitFor(() => expect(api.bodies).toEqual([{ toVersion: 1, baseVersion: 3 }]));
    expect(await screen.findByText('New version created — rollback to v1')).toBeTruthy();
    expect(await screen.findByText('rollback to v1')).toBeTruthy();
    expect(api.historyCalls).toBe(2);
  });

  it('shows a message on 409', async () => {
    historyApi([v(2), v(1)]);
    server.use(
      http.post('/api/skills/:slug/rollback', () => errorResponse(409, 'version_conflict')),
    );
    const { user } = renderWithApp(<HistoryPage />, route);
    await user.click(await screen.findByRole('button', { name: 'Roll back to this version' }));
    await user.click(await screen.findByRole('button', { name: 'Roll back' }));
    expect(await screen.findByText('The skill has changed, refresh the history')).toBeTruthy();
  });
});

describe('DiffPage', () => {
  it('renders per-file diffs as plain text, placeholders and a collapsed unchanged count', async () => {
    const diffs: FileDiff[] = [
      {
        path: 'SKILL.md',
        status: 'modified',
        patch: '--- a\n+++ b\n@@ -1,1 +1,1 @@\n-old\n+<b>new</b>\n',
      },
      { path: 'big.txt', status: 'modified', patch: null, tooLarge: true },
      { path: 'logo.png', status: 'modified', patch: null },
      { path: 'a.md', status: 'unchanged', patch: null },
      { path: 'b.md', status: 'unchanged', patch: null },
    ];
    server.use(http.get('/api/skills/:slug/diff', () => HttpResponse.json(diffs)));
    const { container } = renderWithApp(<DiffPage />, {
      route: '/skills/code-review/diff?from=1&to=2',
      path: '/skills/:slug/diff',
    });
    expect(await screen.findByText('<b>new</b>')).toBeTruthy();
    expect(container.querySelector('b')).toBeNull();
    expect(screen.getByText('Changes are too large to display')).toBeTruthy();
    expect(screen.getByText('Binary file changed')).toBeTruthy();
    expect(screen.getByText('2 unchanged files')).toBeTruthy();
  });
});
