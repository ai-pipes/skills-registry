import { screen, waitFor, within } from '@testing-library/react';
import type { SubagentView } from '@skills/contracts';
import { http, HttpResponse } from 'msw';
import { describe, expect, it } from 'vite-plus/test';
import { subagentView } from '../../test/fixtures.ts';
import { errorResponse, server } from '../../test/msw/handlers.ts';
import { renderWithApp } from '../../test/setup.ts';
import { SubagentPage } from './SubagentPage.tsx';

function subagentApi(initial: SubagentView = subagentView) {
  let current = initial;
  const calls = { archive: 0, restore: 0, requests: [] as string[] };
  server.use(
    http.get('/api/subagents/:slug', ({ request, params }) => {
      calls.requests.push(new URL(request.url).search);
      return params.slug === current.slug
        ? HttpResponse.json(current)
        : errorResponse(404, 'subagent_not_found');
    }),
    http.post('/api/subagents/:slug/archive', () => {
      calls.archive += 1;
      current = { ...current, status: 'archived' };
      return new HttpResponse(null, { status: 204 });
    }),
    http.post('/api/subagents/:slug/restore', () => {
      calls.restore += 1;
      current = { ...current, status: 'active' };
      return new HttpResponse(null, { status: 204 });
    }),
  );
  return calls;
}

function renderSubagent(route = '/subagents/code-reviewer') {
  return renderWithApp(<SubagentPage />, { route, path: '/subagents/:slug' });
}

describe('subagent page', () => {
  it('shows description, model, tools, skill links, the rendered prompt and the install command', async () => {
    subagentApi();
    renderSubagent();
    expect(await screen.findByRole('heading', { level: 1, name: 'code-reviewer' })).toBeTruthy();
    expect(screen.getByText('Reviews diffs before merge.')).toBeTruthy();
    expect(screen.getByText('sonnet')).toBeTruthy();
    expect(screen.getByText('Read')).toBeTruthy();
    expect(screen.getByText('Grep')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'code-review' }).getAttribute('href')).toBe(
      '/skills/code-review',
    );
    expect(screen.getByText('careful').tagName).toBe('STRONG');
    expect(screen.queryByText(/model: sonnet/)).toBeNull();
    expect(screen.getByLabelText<HTMLInputElement>('Install command').value).toBe(
      'skills-registry subagent install code-reviewer',
    );
    expect(screen.getByRole('link', { name: 'Edit' }).getAttribute('href')).toBe(
      '/subagents/code-reviewer/edit',
    );
    expect(screen.getByRole('link', { name: 'History' }).getAttribute('href')).toBe(
      '/subagents/code-reviewer/history',
    );
  });

  it('tools null reads "All tools"', async () => {
    subagentApi({ ...subagentView, tools: null });
    renderSubagent();
    expect(await screen.findByText('All tools')).toBeTruthy();
  });

  it('a prompt with <script> renders as text, not as an element', async () => {
    subagentApi({ ...subagentView, content: '---\nname: x\n---\n\n<script>alert(1)</script>\n' });
    const { container } = renderSubagent();
    await screen.findByRole('heading', { level: 1, name: 'code-reviewer' });
    expect(container.querySelector('script')).toBeNull();
  });

  it('relative links and images in the prompt do not point at skill files', async () => {
    subagentApi({
      ...subagentView,
      content: '---\nname: x\n---\n\n[ref](references/x.md) ![pic](assets/p.png)\n',
    });
    const { container } = renderSubagent();
    await screen.findByRole('heading', { level: 1, name: 'code-reviewer' });
    expect(screen.queryByRole('link', { name: 'ref' })).toBeNull();
    expect(screen.getByText('ref')).toBeTruthy();
    expect(container.querySelector('img')?.getAttribute('src') ?? null).toBeNull();
  });

  it('archiving shows a toast and the page turns archived', async () => {
    const calls = subagentApi();
    const { user } = renderSubagent();
    await user.click(await screen.findByRole('button', { name: 'Archive' }));
    const dialog = await screen.findByRole('alertdialog');
    await user.click(within(dialog).getByRole('button', { name: 'Archive' }));
    expect(await screen.findByText('Subagent archived')).toBeTruthy();
    expect(calls.archive).toBe(1);
    await waitFor(() => expect(screen.getByRole('button', { name: 'Restore' })).toBeTruthy());
  });

  it('a missing subagent says so', async () => {
    subagentApi();
    renderSubagent('/subagents/nope');
    expect(await screen.findByText('Subagent not found')).toBeTruthy();
  });
});
