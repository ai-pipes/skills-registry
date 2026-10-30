import { screen, waitFor, within } from '@testing-library/react';
import type { SkillView } from '@skills/contracts';
import { http, HttpResponse } from 'msw';
import { describe, expect, it } from 'vite-plus/test';
import {
  devopsFolder,
  generalFolder,
  importedCommit,
  importedSource,
  oldFolder,
  skillSummary,
} from '../../test/fixtures.ts';
import { errorResponse, foldersHandler, server } from '../../test/msw/handlers.ts';
import { renderWithApp } from '../../test/setup.ts';
import { SkillPage } from './SkillPage.tsx';
import { githubUrl } from './source.ts';

const view: SkillView = {
  ...skillSummary,
  version: 4,
  source: null,
  sourceCommit: null,
  skillMdSha256: '0'.repeat(64),
  skillMd:
    '---\nname: code-review\ndescription: Reviews a diff.\n---\n\n# Code review\n\nRead **the diff**.\n',
  files: [
    { path: 'SKILL.md', size: 80, binary: false, sha256: '0'.repeat(64) },
    // Non-ASCII (Cyrillic) name on purpose: checks per-segment URL encoding.
    { path: 'references/Мой файл.md', size: 12, binary: false, sha256: '0'.repeat(64) },
    { path: 'references/checklist.md', size: 10, binary: false, sha256: '0'.repeat(64) },
    { path: 'assets/logo.png', size: 2048, binary: true, sha256: '0'.repeat(64) },
    { path: 'data/huge.txt', size: 1_048_577, binary: false, sha256: '0'.repeat(64) },
  ],
};

interface Api {
  /** Raw (still encoded) pathname + search of every file request. */
  fileRequests: string[];
  skillRequests: string[];
  archiveCalls: number;
  restoreCalls: number;
}

function skillApi(initial: SkillView = view): Api {
  let current = initial;
  const api: Api = { fileRequests: [], skillRequests: [], archiveCalls: 0, restoreCalls: 0 };
  server.use(
    http.get('/api/skills/:slug', ({ request, params }) => {
      api.skillRequests.push(new URL(request.url).search);
      return params.slug === current.slug
        ? HttpResponse.json(current)
        : errorResponse(404, 'skill_not_found');
    }),
    http.get('/api/skills/:slug/files/*', ({ request }) => {
      const url = new URL(request.url);
      api.fileRequests.push(url.pathname + url.search);
      return new HttpResponse('file body', { headers: { 'content-type': 'text/plain' } });
    }),
    http.post('/api/skills/:slug/archive', () => {
      api.archiveCalls += 1;
      current = { ...current, status: 'archived' };
      return new HttpResponse(null, { status: 204 });
    }),
    http.post('/api/skills/:slug/restore', () => {
      api.restoreCalls += 1;
      current = { ...current, status: 'active' };
      return new HttpResponse(null, { status: 204 });
    }),
  );
  return api;
}

function renderSkill(route = '/skills/code-review') {
  return renderWithApp(<SkillPage />, { route, path: '/skills/:slug' });
}

/** The "Restore" button, enabled once the folder list (which decides the flow) is loaded. */
async function restoreButton(): Promise<HTMLElement> {
  await screen.findByRole('button', { name: 'Restore' });
  await waitFor(() =>
    expect(screen.getByRole('button', { name: 'Restore' }).hasAttribute('disabled')).toBe(false),
  );
  return screen.getByRole('button', { name: 'Restore' });
}

/** Matches the "Imported from …" paragraph by its whole text. */
function sourceLine(text: string) {
  return (_: string, el: Element | null) => el?.tagName === 'P' && el.textContent === text;
}

describe('skill page', () => {
  it('shows the header, actions, rendered SKILL.md (no front matter) and the file tree', async () => {
    skillApi();
    renderSkill();
    expect(await screen.findByRole('heading', { level: 1, name: 'code-review' })).toBeTruthy();
    expect(screen.getByText('Version 4')).toBeTruthy();
    expect(screen.getByText(/^Updated /)).toBeTruthy();
    expect(screen.queryByText('Archived')).toBeNull();
    expect(screen.getByRole('link', { name: 'Edit' }).getAttribute('href')).toBe(
      '/skills/code-review/edit',
    );
    expect(screen.getByRole('link', { name: 'History' }).getAttribute('href')).toBe(
      '/skills/code-review/history',
    );
    expect(screen.getByRole('button', { name: 'Archive' })).toBeTruthy();
    expect(screen.getByRole('heading', { level: 1, name: 'Code review' })).toBeTruthy();
    expect(screen.getByText('the diff').tagName).toBe('STRONG');
    expect(screen.queryByText(/description: Reviews a diff/)).toBeNull();
    const tree = screen.getByRole('tree', { name: 'Files' });
    for (const name of ['SKILL.md', 'references', 'Мой файл.md', 'checklist.md', 'logo.png']) {
      expect(within(tree).getByText(name)).toBeTruthy();
    }
  });

  it('opens `references/Мой файл.md` by its segment-encoded URL and shows the text', async () => {
    const api = skillApi();
    const { user } = renderSkill();
    await user.click(await screen.findByRole('treeitem', { name: 'Мой файл.md' }));
    expect(await screen.findByText('file body')).toBeTruthy();
    expect(screen.getByText('file body').tagName).toBe('PRE');
    expect(api.fileRequests).toEqual([
      '/api/skills/code-review/files/references/%D0%9C%D0%BE%D0%B9%20%D1%84%D0%B0%D0%B9%D0%BB.md',
    ]);
  });

  it.each([
    ['a binary file', 'logo.png', '/api/skills/code-review/files/assets/logo.png', '2 KB'],
    ['a file over 1 MiB', 'huge.txt', '/api/skills/code-review/files/data/huge.txt', '1 MB'],
  ])('%s is not fetched: size and "Download" instead', async (_, name, href, size) => {
    const api = skillApi();
    const { user } = renderSkill();
    await user.click(await screen.findByRole('treeitem', { name }));
    const download = await screen.findByRole('link', { name: 'Download' });
    expect(download.getAttribute('href')).toBe(href);
    expect(download.hasAttribute('download')).toBe(true);
    expect(screen.getByText(new RegExp(size))).toBeTruthy();
    expect(api.fileRequests).toEqual([]);
  });

  it('archiving asks for confirmation, then shows the badge and a toast', async () => {
    const api = skillApi();
    const { user } = renderSkill();
    await user.click(await screen.findByRole('button', { name: 'Archive' }));
    const dialog = await screen.findByRole('alertdialog');
    expect(within(dialog).getByText('Archive skill?')).toBeTruthy();
    await user.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
    expect(api.archiveCalls).toBe(0);

    await user.click(screen.getByRole('button', { name: 'Archive' }));
    await user.click(
      within(await screen.findByRole('alertdialog')).getByRole('button', {
        name: 'Archive',
      }),
    );
    expect(await screen.findByText('Archived')).toBeTruthy();
    expect(await screen.findByText('Skill archived')).toBeTruthy();
    expect(api.archiveCalls).toBe(1);
    // The closing dialog re-renders with the new labels; wait until it is gone.
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
    expect(screen.getByRole('button', { name: 'Restore' })).toBeTruthy();
    expect(screen.queryByRole('link', { name: 'Edit' })).toBeNull();
  });

  it('restoring an archived skill asks for confirmation and removes the badge', async () => {
    const api = skillApi({ ...view, status: 'archived' });
    const { user } = renderSkill();
    expect(await screen.findByText('Archived')).toBeTruthy();
    expect(screen.queryByRole('link', { name: 'Edit' })).toBeNull();
    expect(screen.getByRole('link', { name: 'History' })).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Restore' }));
    await user.click(
      within(await screen.findByRole('alertdialog')).getByRole('button', {
        name: 'Restore',
      }),
    );
    expect(await screen.findByText('Skill restored')).toBeTruthy();
    await waitFor(() => expect(screen.queryByText('Archived')).toBeNull());
    expect(screen.getByRole('link', { name: 'Edit' })).toBeTruthy();
    expect(api.restoreCalls).toBe(1);
  });

  it('a failed archive keeps the dialog result out and reports the error', async () => {
    skillApi();
    server.use(http.post('/api/skills/:slug/archive', () => errorResponse(500, 'internal')));
    const { user } = renderSkill();
    await user.click(await screen.findByRole('button', { name: 'Archive' }));
    await user.click(
      within(await screen.findByRole('alertdialog')).getByRole('button', {
        name: 'Archive',
      }),
    );
    expect(await screen.findByText('Server error (HTTP 500)')).toBeTruthy();
    expect(screen.queryByText('Archived')).toBeNull();
  });

  it('?version=N shows that version and fetches its files; the date is the skill’s', async () => {
    const api = skillApi({ ...view, version: 2 });
    const { user } = renderSkill('/skills/code-review?version=2');
    expect(await screen.findByText('Version 2')).toBeTruthy();
    expect(api.skillRequests).toEqual(['?version=2']);
    expect(screen.getByText(/^Updated /)).toBeTruthy();
    await user.click(screen.getByRole('treeitem', { name: 'checklist.md' }));
    await screen.findByText('file body');
    expect(api.fileRequests).toEqual([
      '/api/skills/code-review/files/references/checklist.md?version=2',
    ]);
    await user.click(screen.getByRole('treeitem', { name: 'logo.png' }));
    expect((await screen.findByRole('link', { name: 'Download' })).getAttribute('href')).toBe(
      '/api/skills/code-review/files/assets/logo.png?version=2',
    );
  });

  describe('source', () => {
    it('an imported skill shows its origin with a GitHub link', async () => {
      skillApi({ ...view, source: importedSource, sourceCommit: importedCommit });
      renderSkill();
      expect(
        await screen.findByText(
          sourceLine('Imported from anthropics/skills/skills/mcp-builder @ a1b2c3d'),
        ),
      ).toBeTruthy();
      const link = screen.getByRole('link', { name: /anthropics\/skills\/skills\/mcp-builder/ });
      expect(link.getAttribute('href')).toBe(githubUrl(importedSource, importedCommit));
      expect(link.getAttribute('rel')).toContain('noopener');
    });

    it('a skill without a source has no origin line', async () => {
      skillApi();
      renderSkill();
      await screen.findByRole('heading', { level: 1, name: 'code-review' });
      expect(screen.queryByText(/Imported from/)).toBeNull();
    });

    it('an unsafe repo is shown as text, not as a link', async () => {
      skillApi({
        ...view,
        source: { ...importedSource, repo: 'javascript:alert(1)' },
        sourceCommit: importedCommit,
      });
      renderSkill();
      expect(
        await screen.findByText(
          sourceLine('Imported from javascript:alert(1)/skills/mcp-builder @ a1b2c3d'),
        ),
      ).toBeTruthy();
      expect(screen.queryByRole('link', { name: /javascript/ })).toBeNull();
    });
  });

  it('an unknown skill says "Skill not found"', async () => {
    skillApi();
    renderSkill('/skills/missing');
    expect(await screen.findByText('Skill not found')).toBeTruthy();
  });

  describe('folders', () => {
    const archivedView: SkillView = {
      ...view,
      status: 'archived',
      folder: { slug: 'old-project', name: 'Old project' },
    };

    /** Records the POSTs (`METHOD path body`) in order; the skill reflects them. */
    function foldersApi(initial: SkillView = view) {
      const calls: string[] = [];
      let current = initial;
      server.use(
        foldersHandler([generalFolder, devopsFolder, oldFolder]),
        http.get('/api/skills/:slug', () => HttpResponse.json(current)),
        http.post('/api/skills/:slug/move', async ({ request }) => {
          const body = await request.json();
          const folder =
            typeof body === 'object' && body !== null && 'folder' in body
              ? String(body.folder)
              : '';
          calls.push(`move ${JSON.stringify({ folder })}`);
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
        http.post('/api/skills/:slug/restore', async ({ request }) => {
          const text = await request.text();
          calls.push(`restore-skill ${text}`);
          current = { ...current, status: 'active' };
          return new HttpResponse(null, { status: 204 });
        }),
      );
      return calls;
    }

    it('links the folder name to the filtered list', async () => {
      foldersApi();
      renderSkill();
      const link = await screen.findByRole('link', { name: 'General' });
      expect(link.getAttribute('href')).toBe('/skills?folder=general');
    });

    it('an archived skill links to the archived list of its folder', async () => {
      foldersApi(archivedView);
      renderSkill();
      const link = await screen.findByRole('link', { name: 'Old project' });
      expect(link.getAttribute('href')).toBe('/skills?folder=old-project&status=archived');
    });

    it('moves the skill to another active folder and refetches the card', async () => {
      const calls = foldersApi();
      const { user } = renderSkill();
      await user.click(await screen.findByRole('button', { name: 'Move' }));
      const dialog = await screen.findByRole('dialog');
      await user.click(within(dialog).getByRole('combobox'));
      expect(screen.queryByRole('option', { name: 'General' })).toBeNull();
      expect(screen.queryByRole('option', { name: 'Old project' })).toBeNull();
      await user.click(await screen.findByRole('option', { name: 'DevOps' }));
      await user.click(within(dialog).getByRole('button', { name: 'Move' }));
      expect(await screen.findByText('Skill moved to folder “DevOps”')).toBeTruthy();
      expect(calls).toEqual(['move {"folder":"devops"}']);
      expect(await screen.findByRole('link', { name: 'DevOps' })).toBeTruthy();
      await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    });

    it('an archived skill has no "Move"', async () => {
      foldersApi(archivedView);
      renderSkill();
      await screen.findByText('Archived');
      expect(screen.queryByRole('button', { name: 'Move' })).toBeNull();
    });

    it('a skill in an archived folder offers to restore the folder and the skill, in order', async () => {
      const calls = foldersApi(archivedView);
      const { user } = renderSkill();
      await user.click(await restoreButton());
      const dialog = await screen.findByRole('dialog');
      expect(
        within(dialog).getByText(
          'Folder “Old project” is archived: restore the folder or move the skill to another folder',
        ),
      ).toBeTruthy();
      await user.click(within(dialog).getByRole('button', { name: 'Restore folder and skill' }));
      expect(await screen.findByText('Skill restored')).toBeTruthy();
      expect(calls).toEqual(['restore-folder old-project', 'restore-skill ']);
    });

    it('restores the skill into a chosen active folder', async () => {
      const calls = foldersApi(archivedView);
      const { user } = renderSkill();
      await user.click(await restoreButton());
      const dialog = await screen.findByRole('dialog');
      await user.click(within(dialog).getByRole('combobox'));
      await user.click(await screen.findByRole('option', { name: 'General' }));
      await user.click(within(dialog).getByRole('button', { name: 'Restore into this folder' }));
      expect(await screen.findByText('Skill restored')).toBeTruthy();
      expect(calls).toEqual(['restore-skill {"folder":"general"}']);
    });

    it('409 folder_archived on a plain restore opens the choice dialog; its errors stay inside', async () => {
      foldersApi({ ...view, status: 'archived' });
      server.use(
        http.post('/api/skills/:slug/restore', () => errorResponse(409, 'folder_archived')),
      );
      const { user } = renderSkill();
      await user.click(await restoreButton());
      await user.click(
        within(await screen.findByRole('alertdialog')).getByRole('button', {
          name: 'Restore',
        }),
      );
      const dialog = await screen.findByRole('dialog');
      expect(within(dialog).getByText(/Folder “General” is archived/)).toBeTruthy();
      await user.click(within(dialog).getByRole('button', { name: 'Restore folder and skill' }));
      expect(
        await within(dialog).findByText('Folder is archived: choose another one'),
      ).toBeTruthy();
      expect(screen.getByRole('dialog')).toBeTruthy();
    });

    it('reopening the move dialog after a successful move starts clean', async () => {
      foldersApi();
      const { user } = renderSkill();
      await user.click(await screen.findByRole('button', { name: 'Move' }));
      let dialog = await screen.findByRole('dialog');
      await user.click(within(dialog).getByRole('combobox'));
      await user.click(await screen.findByRole('option', { name: 'DevOps' }));
      await user.click(within(dialog).getByRole('button', { name: 'Move' }));
      await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
      await user.click(await screen.findByRole('button', { name: 'Move' }));
      dialog = await screen.findByRole('dialog');
      expect(within(dialog).getByRole('combobox').textContent).toContain('Select a folder');
      expect(within(dialog).getByRole('button', { name: 'Move' }).hasAttribute('disabled')).toBe(
        true,
      );
    });

    it('reopening the move dialog after a failed attempt drops the error and the choice', async () => {
      foldersApi();
      server.use(http.post('/api/skills/:slug/move', () => errorResponse(500, 'internal')));
      const { user } = renderSkill();
      await user.click(await screen.findByRole('button', { name: 'Move' }));
      let dialog = await screen.findByRole('dialog');
      await user.click(within(dialog).getByRole('combobox'));
      await user.click(await screen.findByRole('option', { name: 'DevOps' }));
      await user.click(within(dialog).getByRole('button', { name: 'Move' }));
      expect(await within(dialog).findByRole('alert')).toBeTruthy();
      await user.keyboard('{Escape}');
      await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
      await user.click(screen.getByRole('button', { name: 'Move' }));
      dialog = await screen.findByRole('dialog');
      expect(within(dialog).queryByRole('alert')).toBeNull();
      expect(within(dialog).getByRole('combobox').textContent).toContain('Select a folder');
    });

    it('reopening the restore dialog after a failed attempt drops the error', async () => {
      foldersApi(archivedView);
      server.use(http.post('/api/folders/:slug/restore', () => errorResponse(500, 'internal')));
      const { user } = renderSkill();
      await user.click(await restoreButton());
      let dialog = await screen.findByRole('dialog');
      await user.click(within(dialog).getByRole('button', { name: 'Restore folder and skill' }));
      expect(await within(dialog).findByRole('alert')).toBeTruthy();
      await user.keyboard('{Escape}');
      await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
      await user.click(await restoreButton());
      dialog = await screen.findByRole('dialog');
      expect(within(dialog).queryByRole('alert')).toBeNull();
    });
  });
});
