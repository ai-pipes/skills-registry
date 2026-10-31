import { screen, waitFor, within } from '@testing-library/react';
import type { SubagentSummary } from '@skills/contracts';
import { http, HttpResponse } from 'msw';
import { describe, expect, it } from 'vite-plus/test';
import { subagentSummary } from '../../test/fixtures.ts';
import { errorResponse, server } from '../../test/msw/handlers.ts';
import { renderWithApp } from '../../test/setup.ts';
import { SubagentsListPage } from './SubagentsListPage.tsx';

const planner: SubagentSummary = {
  ...subagentSummary,
  slug: 'planner',
  name: 'planner',
  description: 'Plans work.',
  model: 'inherit',
  tools: null,
  skills: [],
};

/** Answers GET /api/subagents and records every query string. */
function subagentsApi(answer: (params: URLSearchParams) => SubagentSummary[]) {
  const queries: string[] = [];
  server.use(
    http.get('/api/subagents', ({ request }) => {
      const url = new URL(request.url);
      queries.push(url.search);
      return HttpResponse.json(answer(url.searchParams));
    }),
  );
  return queries;
}

describe('subagents list', () => {
  it('shows rows with name, slug, description, model and a link to the page', async () => {
    const queries = subagentsApi(() => [subagentSummary, planner]);
    renderWithApp(<SubagentsListPage />, { route: '/subagents' });
    const row = (await screen.findByText('Reviews diffs before merge.')).closest('li');
    if (!row) throw new Error('no list item');
    const r = within(row);
    expect(r.getByText('code-reviewer', { selector: 'span.font-mono' })).toBeTruthy();
    expect(r.getByText('sonnet')).toBeTruthy();
    expect(r.getByText('v2')).toBeTruthy();
    expect(r.getByText('General')).toBeTruthy();
    expect(r.getByRole('link').getAttribute('href')).toBe('/subagents/code-reviewer');
    expect(queries).toEqual(['?status=active']);
  });

  it('the status tabs ask for archived and all', async () => {
    const queries = subagentsApi(() => [subagentSummary]);
    const { user } = renderWithApp(<SubagentsListPage />, { route: '/subagents' });
    await screen.findAllByRole('listitem');
    await user.click(screen.getByRole('tab', { name: 'Archived' }));
    await waitFor(() => expect(queries.at(-1)).toBe('?status=archived'));
    await user.click(screen.getByRole('tab', { name: 'All' }));
    await waitFor(() => expect(queries.at(-1)).toBe('?status=all'));
  });

  it('search sends q after a pause', async () => {
    const queries = subagentsApi((p) => (p.get('q') ? [planner] : [subagentSummary]));
    const { user } = renderWithApp(<SubagentsListPage />, { route: '/subagents' });
    await screen.findAllByRole('listitem');
    await user.type(screen.getByRole('searchbox', { name: 'Search' }), 'plan');
    expect(await screen.findByText('1 subagent found')).toBeTruthy();
    expect(queries).toEqual(['?status=active', '?status=active&q=plan']);
  });

  it('choosing a folder asks for it', async () => {
    const queries = subagentsApi(() => [subagentSummary]);
    const { user, router } = renderWithApp(<SubagentsListPage />, { route: '/subagents' });
    await screen.findAllByRole('listitem');
    await user.click(screen.getByRole('combobox', { name: 'Folder' }));
    await user.click(await screen.findByRole('option', { name: 'DevOps' }));
    await waitFor(() => expect(queries.at(-1)).toBe('?status=active&folder=devops'));
    expect(router.state.location.search).toContain('folder=devops');
  });

  it('an empty registry offers "Create subagent"', async () => {
    subagentsApi(() => []);
    renderWithApp(<SubagentsListPage />, { route: '/subagents' });
    expect(
      (await screen.findByRole('link', { name: 'Create subagent' })).getAttribute('href'),
    ).toBe('/subagents/new');
  });

  it('a failed load shows the page error', async () => {
    server.use(http.get('/api/subagents', () => errorResponse(500, 'internal')));
    renderWithApp(<SubagentsListPage />, { route: '/subagents' });
    expect(await screen.findByRole('alert')).toBeTruthy();
  });
});
