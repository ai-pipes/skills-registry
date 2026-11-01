import type { SubagentDiff, SubagentVersionSummary } from '@skills/contracts';
import { screen, waitFor, within } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { describe, expect, it } from 'vite-plus/test';
import { routes } from '@/app/routes.tsx';
import { errorResponse, server } from '../../test/msw/handlers.ts';
import { renderWithApp } from '../../test/setup.ts';

const v = (
  number: number,
  extra: Partial<SubagentVersionSummary> = {},
): SubagentVersionSummary => ({
  number,
  authorId: 'u1',
  authorLogin: 'alice',
  message: `edit ${number}`,
  createdAt: '2026-10-01T10:00:00.000Z',
  restoredFrom: null,
  ...extra,
});

describe('subagent history', () => {
  it('lists versions, compares two and rolls back on top of the current one', async () => {
    const bodies: unknown[] = [];
    server.use(
      http.get('/api/subagents/:slug/history', () =>
        HttpResponse.json([v(3, { restoredFrom: 1 }), v(2), v(1)]),
      ),
      http.post('/api/subagents/:slug/rollback', async ({ request }) => {
        bodies.push(await request.json());
        return HttpResponse.json({ slug: 'devops', version: 4 }, { status: 201 });
      }),
    );
    const { user, router } = renderWithApp(routes, { route: '/subagents/devops/history' });

    expect(await screen.findByText('rollback to v1')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Back to subagent' }).getAttribute('href')).toBe(
      '/subagents/devops',
    );
    expect(screen.getAllByRole('link', { name: 'Open' })[1]?.getAttribute('href')).toBe(
      '/subagents/devops?version=2',
    );

    await user.click(screen.getAllByRole('button', { name: 'Roll back to this version' })[1]!);
    const dialog = await screen.findByRole('alertdialog');
    await user.click(within(dialog).getByRole('button', { name: 'Roll back' }));
    await waitFor(() => expect(bodies).toEqual([{ toVersion: 1, baseVersion: 3 }]));

    await user.click(screen.getByRole('checkbox', { name: 'Select version 3' }));
    await user.click(screen.getByRole('checkbox', { name: 'Select version 2' }));
    await user.click(screen.getByRole('button', { name: 'Compare' }));
    expect(router.state.location.pathname + router.state.location.search).toBe(
      '/subagents/devops/diff?from=2&to=3',
    );
  });

  it('says the subagent changed on a 409', async () => {
    server.use(
      http.get('/api/subagents/:slug/history', () => HttpResponse.json([v(2), v(1)])),
      http.post('/api/subagents/:slug/rollback', () => errorResponse(409, 'version_conflict')),
    );
    const { user } = renderWithApp(routes, { route: '/subagents/devops/history' });
    await user.click(await screen.findByRole('button', { name: 'Roll back to this version' }));
    await user.click(
      within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Roll back' }),
    );
    expect(await screen.findByText('The subagent has changed, refresh the history')).toBeTruthy();
  });
});

function diffApi(diff: SubagentDiff) {
  server.use(http.get('/api/subagents/:slug/diff', () => HttpResponse.json(diff)));
}

const PATCH = '@@ -1,1 +1,1 @@\n-old line\n+new line\n';
const diffRoute = '/subagents/devops/diff?from=1&to=2';

describe('subagent diff', () => {
  it('shows "Permissions changed" with added and removed tools above the text diff', async () => {
    diffApi({ patch: PATCH, tools: { from: ['Read', 'Write'], to: ['Read', 'Bash'] } });
    renderWithApp(routes, { route: diffRoute });

    const block = await screen.findByRole('region', { name: 'Permissions changed' });
    expect(within(block).getByText('+ Bash')).toBeTruthy();
    expect(within(block).getByText('- Write')).toBeTruthy();
    expect(within(block).queryByText(/Read/)).toBeNull();
    const diff = screen.getByRole('region', { name: 'SUBAGENT.md' });
    expect(within(diff).getByText('new line')).toBeTruthy();
    expect(block.compareDocumentPosition(diff) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('lists "All tools" when tools become restricted or unrestricted', async () => {
    diffApi({ patch: PATCH, tools: { from: null, to: ['Read'] } });
    renderWithApp(routes, { route: diffRoute });
    const block = await screen.findByRole('region', { name: 'Permissions changed' });
    expect(within(block).getByText('+ Read')).toBeTruthy();
    expect(within(block).getByText('- All tools')).toBeTruthy();
  });

  it('shows no block when the tools are equal', async () => {
    diffApi({ patch: PATCH, tools: { from: ['Read'], to: ['Read'] } });
    renderWithApp(routes, { route: diffRoute });
    expect(await screen.findByText('new line')).toBeTruthy();
    expect(screen.queryByRole('region', { name: 'Permissions changed' })).toBeNull();
  });

  it('shows no block when both versions inherit all tools', async () => {
    diffApi({ patch: PATCH, tools: { from: null, to: null } });
    renderWithApp(routes, { route: diffRoute });
    expect(await screen.findByText('new line')).toBeTruthy();
    expect(screen.queryByRole('region', { name: 'Permissions changed' })).toBeNull();
  });

  it('asks for two versions when the range is missing', async () => {
    renderWithApp(routes, { route: '/subagents/devops/diff' });
    expect(await screen.findByText('Select two versions to compare')).toBeTruthy();
  });
});
