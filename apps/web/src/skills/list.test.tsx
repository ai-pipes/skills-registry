import { screen, waitFor, within } from '@testing-library/react';
import type { SkillSummary } from '@skills/contracts';
import { http, HttpResponse } from 'msw';
import { describe, expect, it } from 'vite-plus/test';
import { devopsFolder, oldFolder, skillSummary } from '../../test/fixtures.ts';
import { errorResponse, foldersHandler, server } from '../../test/msw/handlers.ts';
import { renderWithApp } from '../../test/setup.ts';
import { SkillsListPage } from './SkillsListPage.tsx';

const pdf: SkillSummary = {
  slug: 'pdf-tools',
  name: 'PDF tools',
  description: 'Reads and fills PDF forms.',
  status: 'active',
  folder: { slug: 'general', name: 'General' },
  version: 3,
  updatedAt: '2026-10-27T12:00:00.000Z',
};

/** Answers GET /api/skills with `answer(status, q)` and records every query string. */
function skillsApi(answer: (status: string, q: string | null) => SkillSummary[]) {
  const requests: { status: string; q: string | null }[] = [];
  server.use(
    http.get('/api/skills', ({ request }) => {
      const params = new URL(request.url).searchParams;
      const call = { status: params.get('status') ?? '', q: params.get('q') };
      requests.push(call);
      return HttpResponse.json(answer(call.status, call.q));
    }),
  );
  return requests;
}

/** Records the query string of every GET /api/skills. */
function recordQueries() {
  const queries: string[] = [];
  server.use(
    http.get('/api/skills', ({ request }) => {
      queries.push(new URL(request.url).search);
      return HttpResponse.json([skillSummary]);
    }),
  );
  return queries;
}

describe('skills list', () => {
  it('shows name, slug, description, version and relative update time of active skills', async () => {
    const requests = skillsApi(() => [skillSummary, pdf]);
    renderWithApp(<SkillsListPage />, { route: '/skills' });
    const row = (await screen.findByText('PDF tools')).closest('li');
    if (!row) throw new Error('no list item');
    const r = within(row);
    expect(r.getByText('pdf-tools')).toBeTruthy();
    expect(r.getByText('Reads and fills PDF forms.')).toBeTruthy();
    expect(r.getByText('v3')).toBeTruthy();
    expect(r.getByText(/ago|yesterday|today|tomorrow|now|^in /)).toBeTruthy();
    expect(r.getByRole('link', { name: /PDF tools/ }).getAttribute('href')).toBe(
      '/skills/pdf-tools',
    );
    expect(requests).toEqual([{ status: 'active', q: null }]);
    expect(screen.queryByText(/ found$/)).toBeNull();
  });

  it('the status filter asks for archived and for all skills', async () => {
    const requests = skillsApi(() => [skillSummary]);
    const { user } = renderWithApp(<SkillsListPage />, { route: '/skills' });
    await screen.findAllByRole('listitem');
    await user.click(screen.getByRole('tab', { name: 'Archived' }));
    await waitFor(() => expect(requests.at(-1)).toEqual({ status: 'archived', q: null }));
    await user.click(screen.getByRole('tab', { name: 'All' }));
    await waitFor(() => expect(requests.at(-1)).toEqual({ status: 'all', q: null }));
    expect(screen.getByRole('tab', { name: 'All' }).getAttribute('aria-selected')).toBe('true');
  });

  it('search sends q after a pause, keeps the server order and shows "2 skills found"', async () => {
    const requests = skillsApi((_, q) => (q ? [pdf, skillSummary] : [skillSummary]));
    const { user } = renderWithApp(<SkillsListPage />, { route: '/skills' });
    await screen.findAllByRole('listitem');
    await user.type(screen.getByRole('searchbox', { name: 'Search' }), 'forms');
    expect(await screen.findByText('2 skills found')).toBeTruthy();
    // Debounced: one request for the whole word, none per keystroke.
    expect(requests).toEqual([
      { status: 'active', q: null },
      { status: 'active', q: 'forms' },
    ]);
    const names = screen.getAllByRole('listitem').map((li) => li.querySelector('a')?.textContent);
    expect(names[0]).toContain('PDF tools');
    expect(names[1]).toContain('code-review');
  });

  it('a search without hits says "Nothing found"', async () => {
    skillsApi((_, q) => (q ? [] : [skillSummary]));
    const { user } = renderWithApp(<SkillsListPage />, { route: '/skills' });
    await screen.findAllByRole('listitem');
    await user.type(screen.getByRole('searchbox', { name: 'Search' }), 'nothing');
    expect(await screen.findByText('Nothing found')).toBeTruthy();
    expect(screen.getByText('0 skills found')).toBeTruthy();
  });

  it('an empty registry offers "Create skill"', async () => {
    skillsApi(() => []);
    renderWithApp(<SkillsListPage />, { route: '/skills' });
    expect((await screen.findByRole('link', { name: 'Create skill' })).getAttribute('href')).toBe(
      '/skills/new',
    );
    expect(screen.queryByRole('link', { name: 'Import' })).toBeNull();
  });

  it('a failed load shows the page error', async () => {
    server.use(http.get('/api/skills', () => errorResponse(500, 'internal')));
    renderWithApp(<SkillsListPage />, { route: '/skills' });
    expect(await screen.findByRole('alert')).toBeTruthy();
    expect(screen.getByText('Server error (HTTP 500)')).toBeTruthy();
  });

  describe('folder filter', () => {
    it('shows the folder name on each row', async () => {
      skillsApi(() => [skillSummary]);
      renderWithApp(<SkillsListPage />, { route: '/skills' });
      const row = (
        await screen.findByText('code-review', { selector: 'span.font-medium' })
      ).closest('li');
      if (!row) throw new Error('no list item');
      expect(within(row).getByText('General')).toBeTruthy();
    });

    it('choosing a folder asks for it and writes it to the URL; "All folders" removes it', async () => {
      const queries = recordQueries();
      const { user, router } = renderWithApp(<SkillsListPage />, { route: '/skills' });
      await screen.findAllByRole('listitem');
      await user.click(screen.getByRole('combobox', { name: 'Folder' }));
      await user.click(await screen.findByRole('option', { name: 'DevOps' }));
      await waitFor(() => expect(queries.at(-1)).toBe('?status=active&folder=devops'));
      expect(router.state.location.search).toContain('folder=devops');

      await user.click(screen.getByRole('combobox', { name: 'Folder' }));
      await user.click(await screen.findByRole('option', { name: 'All folders' }));
      await waitFor(() => expect(queries.at(-1)).toBe('?status=active'));
      expect(router.state.location.search).not.toContain('folder');
      // The archived folder is not offered while it is not selected.
      await user.click(screen.getByRole('combobox', { name: 'Folder' }));
      expect(screen.queryByRole('option', { name: /Old project/ })).toBeNull();
    });

    it('an archived folder in the URL is shown with the archive mark', async () => {
      const queries = recordQueries();
      renderWithApp(<SkillsListPage />, { route: '/skills?folder=old-project' });
      const select = await screen.findByRole('combobox', { name: 'Folder' });
      await waitFor(() => expect(select.textContent).toContain('Old project'));
      expect(select.textContent).toContain('archived');
      await waitFor(() => expect(queries).toContain('?status=active&folder=old-project'));
    });

    it('an unknown folder in the URL shows "All folders" and an empty list, still asking with it', async () => {
      server.use(foldersHandler([devopsFolder, oldFolder]));
      const queries: string[] = [];
      server.use(
        http.get('/api/skills', ({ request }) => {
          queries.push(new URL(request.url).search);
          return HttpResponse.json([]);
        }),
      );
      renderWithApp(<SkillsListPage />, { route: '/skills?folder=nope' });
      expect(await screen.findByText('No skills yet')).toBeTruthy();
      expect(queries).toContain('?status=active&folder=nope');
      expect(screen.getByRole('combobox', { name: 'Folder' }).textContent).toContain('All folders');
    });

    it('the create buttons carry the selected folder', async () => {
      recordQueries();
      renderWithApp(<SkillsListPage />, { route: '/skills?folder=devops' });
      expect((await screen.findByRole('link', { name: 'New skill' })).getAttribute('href')).toBe(
        '/skills/new?folder=devops',
      );
    });

    it('the empty-state action carries the selected folder', async () => {
      skillsApi(() => []);
      renderWithApp(<SkillsListPage />, { route: '/skills?folder=devops' });
      expect((await screen.findByRole('link', { name: 'Create skill' })).getAttribute('href')).toBe(
        '/skills/new?folder=devops',
      );
    });
  });
});
