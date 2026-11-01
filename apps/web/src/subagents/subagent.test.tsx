import { screen, waitFor, within } from '@testing-library/react';
import type { SubagentView } from '@skills/contracts';
import { http, HttpResponse } from 'msw';
import { describe, expect, it } from 'vite-plus/test';
import { devopsFolder, generalFolder, oldFolder, subagentView } from '../../test/fixtures.ts';
import { errorResponse, foldersHandler, server } from '../../test/msw/handlers.ts';
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

const archivedView: SubagentView = {
  ...subagentView,
  status: 'archived',
  folder: { slug: 'old-project', name: 'Old project' },
};

/** Records the POSTs (`METHOD path body`) in order; the subagent reflects them. */
function foldersApi(initial: SubagentView = subagentView) {
  const calls: string[] = [];
  let current = initial;
  server.use(
    foldersHandler([generalFolder, devopsFolder, oldFolder]),
    http.get('/api/subagents/:slug', () => HttpResponse.json(current)),
    http.post('/api/subagents/:slug/move', async ({ request }) => {
      const body: unknown = await request.json();
      const folder =
        typeof body === 'object' && body !== null && 'folder' in body ? String(body.folder) : '';
      calls.push(`move ${folder}`);
      current = {
        ...current,
        folder: { slug: folder, name: folder === 'devops' ? 'DevOps' : 'General' },
      };
      return new HttpResponse(null, { status: 204 });
    }),
    http.post('/api/folders/:slug/restore', ({ params }) => {
      calls.push(`restore-folder ${String(params['slug'])}`);
      return new HttpResponse(null, { status: 204 });
    }),
    http.post('/api/subagents/:slug/restore', async ({ request }) => {
      calls.push(`restore-subagent ${await request.text()}`);
      current = { ...current, status: 'active' };
      return new HttpResponse(null, { status: 204 });
    }),
  );
  return calls;
}

/** The "Restore" button, enabled once the folder list (which decides the flow) is loaded. */
async function restoreButton(): Promise<HTMLElement> {
  await screen.findByRole('button', { name: 'Restore' });
  await waitFor(() =>
    expect(screen.getByRole('button', { name: 'Restore' }).hasAttribute('disabled')).toBe(false),
  );
  return screen.getByRole('button', { name: 'Restore' });
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

  it('?version=N shows that version and requests it', async () => {
    const calls = subagentApi();
    server.use(
      http.get('/api/subagents/:slug', ({ request }) => {
        const version = new URL(request.url).searchParams.get('version');
        calls.requests.push(version ?? '');
        return HttpResponse.json(
          version === '1'
            ? {
                ...subagentView,
                version: 1,
                description: 'First draft.',
                model: 'haiku',
                tools: null,
                skills: [],
              }
            : subagentView,
        );
      }),
    );
    renderSubagent('/subagents/code-reviewer?version=1');
    expect(await screen.findByText('Version 1')).toBeTruthy();
    expect(screen.getByText('First draft.')).toBeTruthy();
    expect(screen.getByText('haiku')).toBeTruthy();
    expect(screen.getByText('All tools')).toBeTruthy();
    expect(screen.queryByText('Reviews diffs before merge.')).toBeNull();
    expect(calls.requests).toEqual(['1']);
  });

  it('an unknown ?version=N says no such version', async () => {
    server.use(http.get('/api/subagents/:slug', () => errorResponse(404, 'version_not_found')));
    renderSubagent('/subagents/code-reviewer?version=99');
    expect(await screen.findByText('No such version')).toBeTruthy();
  });

  describe('folders', () => {
    it('moves the subagent to another active folder and refetches the card', async () => {
      const calls = foldersApi();
      const { user } = renderSubagent();
      await user.click(await screen.findByRole('button', { name: 'Move' }));
      const dialog = await screen.findByRole('dialog');
      await user.click(within(dialog).getByRole('combobox'));
      expect(screen.queryByRole('option', { name: 'General' })).toBeNull();
      expect(screen.queryByRole('option', { name: 'Old project' })).toBeNull();
      await user.click(await screen.findByRole('option', { name: 'DevOps' }));
      await user.click(within(dialog).getByRole('button', { name: 'Move' }));
      expect(await screen.findByText('Subagent moved to folder “DevOps”')).toBeTruthy();
      expect(calls).toEqual(['move devops']);
      expect(await screen.findByRole('link', { name: 'DevOps' })).toBeTruthy();
      await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    });

    it('a move error is worded for a subagent, not a skill', async () => {
      foldersApi();
      server.use(
        http.post('/api/subagents/:slug/move', () => errorResponse(404, 'subagent_not_found')),
      );
      const { user } = renderSubagent();
      await user.click(await screen.findByRole('button', { name: 'Move' }));
      const dialog = await screen.findByRole('dialog');
      await user.click(within(dialog).getByRole('combobox'));
      await user.click(await screen.findByRole('option', { name: 'DevOps' }));
      await user.click(within(dialog).getByRole('button', { name: 'Move' }));
      const alert = await within(dialog).findByRole('alert');
      expect(alert.textContent).toContain('Subagent not found');
      expect(alert.textContent).not.toMatch(/skill/i);
    });

    it('a subagent in an archived folder offers to restore the folder and the subagent, in order', async () => {
      const calls = foldersApi(archivedView);
      const { user } = renderSubagent();
      await user.click(await restoreButton());
      const dialog = await screen.findByRole('dialog');
      expect(
        within(dialog).getByText(
          'Folder “Old project” is archived: restore the folder or move the subagent to another folder',
        ),
      ).toBeTruthy();
      await user.click(within(dialog).getByRole('button', { name: 'Restore folder and subagent' }));
      expect(await screen.findByText('Subagent restored')).toBeTruthy();
      expect(calls).toEqual(['restore-folder old-project', 'restore-subagent ']);
    });

    it('restores the subagent into a chosen active folder', async () => {
      const calls = foldersApi(archivedView);
      const { user } = renderSubagent();
      await user.click(await restoreButton());
      const dialog = await screen.findByRole('dialog');
      await user.click(within(dialog).getByRole('combobox'));
      await user.click(await screen.findByRole('option', { name: 'General' }));
      await user.click(within(dialog).getByRole('button', { name: 'Restore into this folder' }));
      expect(await screen.findByText('Subagent restored')).toBeTruthy();
      expect(calls).toEqual(['restore-subagent {"folder":"general"}']);
    });

    it('a restore error inside the dialog is worded for a subagent', async () => {
      foldersApi(archivedView);
      server.use(
        http.post('/api/folders/:slug/restore', () => errorResponse(404, 'folder_not_found')),
        http.post('/api/subagents/:slug/restore', () => errorResponse(404, 'subagent_not_found')),
      );
      const { user } = renderSubagent();
      await user.click(await restoreButton());
      const dialog = await screen.findByRole('dialog');
      await user.click(within(dialog).getByRole('combobox'));
      await user.click(await screen.findByRole('option', { name: 'General' }));
      await user.click(within(dialog).getByRole('button', { name: 'Restore into this folder' }));
      const alert = await within(dialog).findByRole('alert');
      expect(alert.textContent).toContain('Subagent not found');
      expect(alert.textContent).not.toMatch(/skill/i);
    });
  });
});
