import { screen, waitFor, within } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { describe, expect, it } from 'vite-plus/test';
import { routes } from '@/app/routes.tsx';
import { errorResponse, server } from '../../test/msw/handlers.ts';
import { renderWithApp } from '../../test/setup.ts';

describe('FoldersPage', () => {
  it('lists active folders with links into skills; archived tab asks for archived', async () => {
    const statuses: (string | null)[] = [];
    server.use(
      http.get('/api/skills', () => HttpResponse.json([])),
      http.get('/api/folders', ({ request }) => {
        const status = new URL(request.url).searchParams.get('status');
        statuses.push(status);
        return HttpResponse.json(
          status === 'archived'
            ? [
                {
                  slug: 'old-project',
                  name: 'Old project',
                  description: 'Project archive',
                  status: 'archived',
                  skills: { active: 0, archived: 2 },
                },
              ]
            : [
                {
                  slug: 'general',
                  name: 'General',
                  description: 'General skills without a specific topic',
                  status: 'active',
                  skills: { active: 1, archived: 0 },
                },
                {
                  slug: 'devops',
                  name: 'DevOps',
                  description: 'Builds, deploys, CI',
                  status: 'active',
                  skills: { active: 0, archived: 0 },
                },
              ],
        );
      }),
    );
    const { user, router } = renderWithApp(routes, { route: '/folders' });
    const link = await screen.findByRole('link', { name: 'General' });
    expect(link.getAttribute('href')).toBe('/skills?folder=general');
    expect(screen.getByText('DevOps')).toBeTruthy();
    await user.click(screen.getByRole('tab', { name: 'Archived' }));
    const old = await screen.findByRole('link', { name: 'Old project' });
    expect(old.getAttribute('href')).toBe('/skills?folder=old-project&status=archived');
    // the archive tab counts archived skills, not the (always zero) active ones
    expect(old.closest('tr')?.textContent).toContain('2');
    expect(router.state.location.search).toBe('?status=archived');
    expect(statuses).toContain('archived');
  });

  it('archives a folder after confirmation and shows a toast', async () => {
    let called = false;
    server.use(
      http.get('/api/skills', () => HttpResponse.json([])),
      http.post('/api/folders/general/archive', () => {
        called = true;
        return HttpResponse.json({ archivedSkills: 1 });
      }),
    );
    const { user } = renderWithApp(routes, { route: '/folders' });
    const row = (await screen.findByRole('link', { name: 'General' })).closest('tr')!;
    await user.click(within(row).getByRole('button', { name: 'Archive' }));
    const dialog = await screen.findByRole('alertdialog');
    expect(within(dialog).getByText('Archive folder “General”?')).toBeTruthy();
    expect(dialog.textContent).toContain('1 active skill will be archived');
    await user.click(within(dialog).getByRole('button', { name: 'Archive' }));
    await waitFor(() => expect(called).toBe(true));
    expect(await screen.findByText('Folder “General” archived')).toBeTruthy();
  });

  it('shows a 409 inside the archive dialog', async () => {
    server.use(
      http.post('/api/folders/general/archive', () => errorResponse(409, 'folder_archived')),
    );
    const { user } = renderWithApp(routes, { route: '/folders' });
    const row = (await screen.findByRole('link', { name: 'General' })).closest('tr')!;
    await user.click(within(row).getByRole('button', { name: 'Archive' }));
    const dialog = await screen.findByRole('alertdialog');
    await user.click(within(dialog).getByRole('button', { name: 'Archive' }));
    expect(await within(dialog).findByRole('alert')).toBeTruthy();
  });

  it('restores an archived folder and warns that its skills stay archived', async () => {
    let called = false;
    server.use(
      http.post('/api/folders/old-project/restore', () => {
        called = true;
        return new HttpResponse(null, { status: 204 });
      }),
    );
    const { user } = renderWithApp(routes, { route: '/folders?status=archived' });
    const row = (await screen.findByRole('link', { name: 'Old project' })).closest('tr')!;
    await user.click(within(row).getByRole('button', { name: 'Restore' }));
    const dialog = await screen.findByRole('alertdialog');
    await user.click(within(dialog).getByRole('button', { name: 'Restore' }));
    await waitFor(() => expect(called).toBe(true));
    expect(await screen.findByText(/stay archived/)).toBeTruthy();
  });

  it('an empty archive shows an empty state', async () => {
    server.use(http.get('/api/folders', () => HttpResponse.json([])));
    renderWithApp(routes, { route: '/folders?status=archived' });
    expect(await screen.findByText('No archived folders')).toBeTruthy();
  });
});

describe('FolderFormPage (create)', () => {
  it('validates on the client without requests', async () => {
    let posted = false;
    server.use(
      http.post('/api/folders', () => {
        posted = true;
        return HttpResponse.json({ slug: 'x', name: 'x' }, { status: 201 });
      }),
    );
    const { user } = renderWithApp(routes, { route: '/folders/new' });
    await user.click(await screen.findByRole('button', { name: 'Save' }));
    expect(await screen.findByText('Enter a slug')).toBeTruthy();
    await user.type(screen.getByLabelText('Slug'), 'Bad slug');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    expect(
      await screen.findByText(
        'Only lowercase Latin letters, digits and single hyphens between them',
      ),
    ).toBeTruthy();
    await user.clear(screen.getByLabelText('Slug'));
    await user.type(screen.getByLabelText('Slug'), 'qa');
    await user.type(screen.getByLabelText('Name'), 'QA');
    await user.type(screen.getByLabelText('Description'), '   ');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByText('Enter a description')).toBeTruthy();
    expect(posted).toBe(false);
  });

  it('creates a folder and goes to /folders', async () => {
    let body: unknown;
    server.use(
      http.post('/api/folders', async ({ request }) => {
        body = await request.json();
        return HttpResponse.json({ slug: 'qa', name: 'QA' }, { status: 201 });
      }),
    );
    const { user, router } = renderWithApp(routes, { route: '/folders/new' });
    await user.type(await screen.findByLabelText('Slug'), 'qa');
    await user.type(screen.getByLabelText('Name'), 'QA');
    await user.type(screen.getByLabelText('Description'), 'Testing');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(router.state.location.pathname).toBe('/folders'));
    expect(body).toEqual({ slug: 'qa', name: 'QA', description: 'Testing' });
    expect(await screen.findByText('Folder created')).toBeTruthy();
  });

  it('folder_exists is shown under the slug field', async () => {
    server.use(http.post('/api/folders', () => errorResponse(409, 'folder_exists')));
    const { user } = renderWithApp(routes, { route: '/folders/new' });
    await user.type(await screen.findByLabelText('Slug'), 'general');
    await user.type(screen.getByLabelText('Name'), 'General');
    await user.type(screen.getByLabelText('Description'), 'Text');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    const text = await screen.findByText('A folder with this slug already exists');
    expect(screen.getByLabelText('Slug').getAttribute('aria-describedby')).toContain(text.id);
  });
});

describe('FolderFormPage (edit)', () => {
  it('slug is read-only; PUT sends the new name', async () => {
    let body: unknown;
    server.use(
      http.put('/api/folders/devops', async ({ request }) => {
        body = await request.json();
        return HttpResponse.json({ slug: 'devops', name: 'Ops' });
      }),
    );
    const { user, router } = renderWithApp(routes, { route: '/folders/devops/edit' });
    const slug = await screen.findByLabelText('Slug');
    expect(slug.getAttribute('readonly')).not.toBeNull();
    expect(slug).toHaveProperty('value', 'devops');
    const name = screen.getByLabelText('Name');
    await user.clear(name);
    await user.type(name, 'Ops');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(router.state.location.pathname).toBe('/folders'));
    expect(body).toEqual({ name: 'Ops', description: 'Builds, deploys, CI' });
  });

  it('an unknown folder shows "Folder not found"', async () => {
    renderWithApp(routes, { route: '/folders/nope/edit' });
    expect(await screen.findByRole('heading', { name: 'Folder not found' })).toBeTruthy();
  });
});
