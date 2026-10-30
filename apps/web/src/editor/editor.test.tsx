import { EditorView } from '@codemirror/view';
import { act, screen, waitFor, within } from '@testing-library/react';
import type { SkillView, VersionRef } from '@skills/contracts';
import { http, HttpResponse } from 'msw';
import { beforeEach, describe, expect, it } from 'vite-plus/test';
import { routes } from '@/app/routes.tsx';
import { oldFolder, skillSummary } from '../../test/fixtures.ts';
import { errorResponse, foldersHandler, server } from '../../test/msw/handlers.ts';
import { renderWithApp } from '../../test/setup.ts';
import { loadDraft, unfreezeDrafts } from './draft.ts';

const SKILL_MD = '---\nname: code-review\ndescription: Reviews a diff.\n---\n\n# Code review\n';

const v4: SkillView = {
  ...skillSummary,
  version: 4,
  source: null,
  sourceCommit: null,
  skillMdSha256: '0'.repeat(64),
  skillMd: SKILL_MD,
  // As the server sends it: SKILL.md is not in `files`, its text is `skillMd`.
  files: [
    { path: 'references/checklist.md', size: 10, binary: false, sha256: '0'.repeat(64) },
    { path: 'assets/logo.png', size: 2048, binary: true, sha256: '0'.repeat(64) },
  ],
};

/** A multipart request as the test sees it (jsdom loses file names: compare fields only). */
interface Sent {
  method: string;
  url: string;
  fields: Record<string, string>;
  /** Field name → content of every file part. */
  parts: Record<string, string>;
}

async function readForm(request: Request): Promise<Sent> {
  const form = await request.formData();
  const fields: Record<string, string> = {};
  const parts: Record<string, string> = {};
  const texts = [...form.entries()].map(async ([name, value]) => {
    if (typeof value === 'string') fields[name] = value;
    else parts[name] = await value.text();
  });
  await Promise.all(texts);
  return { method: request.method, url: new URL(request.url).pathname, fields, parts };
}

interface Backend {
  sent: Sent[];
  /** Answers of the next saves, in order; after them every save succeeds. */
  saveAnswers: (() => Response)[];
  /** What `GET /api/skills/code-review` (no version) returns. */
  current: SkillView;
  fileRequests: string[];
}

function backend(): Backend {
  const b: Backend = { sent: [], saveAnswers: [], current: v4, fileRequests: [] };
  const answer = (version: number, slug = 'code-review') => {
    const next = b.saveAnswers.shift();
    if (next) return next();
    const ref: VersionRef = { slug, version };
    return HttpResponse.json(ref, { status: 201 });
  };
  server.use(
    http.get('/api/skills/:slug', ({ request, params }) => {
      const version = new URL(request.url).searchParams.get('version');
      if (params.slug !== 'code-review' && params.slug !== 'my-skill') {
        return errorResponse(404, 'skill_not_found');
      }
      if (version === '4') return HttpResponse.json(v4);
      if (params.slug === 'my-skill') return HttpResponse.json({ ...v4, slug: 'my-skill' });
      return HttpResponse.json(b.current);
    }),
    http.get('/api/skills/:slug/files/*', ({ request }) => {
      const url = new URL(request.url);
      b.fileRequests.push(url.pathname + url.search);
      return new HttpResponse('checklist text', { headers: { 'content-type': 'text/plain' } });
    }),
    http.put('/api/skills/:slug', async ({ request }) => {
      const sent = await readForm(request);
      b.sent.push(sent);
      return answer(Number(sent.fields['baseVersion']) + 1);
    }),
    http.post('/api/skills', async ({ request }) => {
      const sent = await readForm(request);
      b.sent.push(sent);
      return answer(1, sent.fields['slug']);
    }),
    http.post('/api/auth/login', () => new HttpResponse(null, { status: 204 })),
    http.post('/api/auth/logout', () => new HttpResponse(null, { status: 204 })),
  );
  return b;
}

// Cleared before each test: unmounting a dirty editor (cleanup) flushes its draft.
beforeEach(() => {
  sessionStorage.clear();
  unfreezeDrafts(); // a logout test leaves drafts frozen until the next login
});

// jsdom has no layout: CodeMirror measures text through Range rects.
const emptyRect = { x: 0, y: 0, width: 0, height: 0, top: 0, left: 0, right: 0, bottom: 0 };
for (const name of ['getClientRects', 'getBoundingClientRect'] as const) {
  if (!(name in Range.prototype)) {
    Object.defineProperty(Range.prototype, name, {
      configurable: true,
      value:
        name === 'getClientRects' ? () => [] : () => ({ ...emptyRect, toJSON: () => emptyRect }),
    });
  }
}

/** The CodeMirror view inside the editor's shadow root. */
function editorView(): EditorView {
  const host = screen.getByTestId('code-editor');
  const cm = host.shadowRoot?.querySelector('.cm-editor');
  const view = cm instanceof HTMLElement ? EditorView.findFromDOM(cm) : null;
  if (!view) throw new Error('no CodeMirror view');
  return view;
}

async function findEditor(): Promise<EditorView> {
  await waitFor(() => editorView());
  return editorView();
}

function typeInEditor(view: EditorView, text: string) {
  act(() => {
    view.dispatch({ changes: { from: view.state.doc.length, insert: text } });
  });
}

/** The `keep` field, sorted. */
function keep(sent: Sent | undefined): string[] {
  const value: unknown = JSON.parse(sent?.fields['keep'] ?? 'null');
  if (!Array.isArray(value)) throw new Error('keep is not an array');
  return value.map(String).toSorted();
}

function renderEdit() {
  return renderWithApp(routes, { route: '/skills/code-review/edit' });
}

describe('editing a skill', () => {
  it('mounts CodeMirror in a shadow root without inserting <style> into the document', async () => {
    backend();
    renderEdit();
    const view = await findEditor();
    expect(view.state.doc.toString()).toBe(SKILL_MD);
    expect(screen.getByTestId('code-editor').shadowRoot).not.toBeNull();
    const cmStyles = [...document.querySelectorAll('style')].filter((s) =>
      (s.textContent ?? '').includes('.cm-'),
    );
    expect(cmStyles).toEqual([]);
  });

  it('with only SKILL.md changed sends it as a part and keeps every other path', async () => {
    const b = backend();
    const { router, user } = renderEdit();
    typeInEditor(await findEditor(), '\nMore.\n');
    await user.type(screen.getByLabelText('Change message'), 'clarify');
    await user.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(router.state.location.pathname).toBe('/skills/code-review'));
    expect(b.sent).toHaveLength(1);
    const [sent] = b.sent;
    expect(sent?.method).toBe('PUT');
    expect(sent?.url).toBe('/api/skills/code-review');
    expect(sent?.fields['baseVersion']).toBe('4');
    expect(sent?.fields['message']).toBe('clarify');
    expect(keep(sent)).toEqual(['assets/logo.png', 'references/checklist.md']);
    expect(sent?.parts).toEqual({ 'SKILL.md': `${SKILL_MD}\nMore.\n` });
    expect(await screen.findByText('Saved: version 5')).toBeTruthy();
    expect(loadDraft('code-review', 'admin')).toBeNull();
  });

  it('adds, uploads and removes files', async () => {
    const b = backend();
    const { user } = renderEdit();
    await findEditor();

    await user.type(screen.getByLabelText('New file path'), 'references/new.md');
    await user.click(screen.getByRole('button', { name: 'Add file' }));
    typeInEditor(editorView(), 'new text');

    await user.type(screen.getByLabelText('Upload to folder'), 'assets/');
    const upload = new File(['PNGDATA'], 'icon.png', { type: 'image/png' });
    await user.upload(screen.getByLabelText('Upload files'), upload);

    await user.click(screen.getByRole('button', { name: 'Remove references/checklist.md' }));
    await user.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(b.sent).toHaveLength(1));
    const [sent] = b.sent;
    expect(keep(sent)).toEqual(['SKILL.md', 'assets/logo.png']);
    expect(sent?.parts).toEqual({ 'references/new.md': 'new text', 'assets/icon.png': 'PNGDATA' });
  });

  it('opening a kept text file loads it from the base version; editing makes it text', async () => {
    const b = backend();
    const { user } = renderEdit();
    await findEditor();
    await user.click(screen.getByRole('button', { name: /^references\/checklist\.md/ }));
    await waitFor(() => expect(editorView().state.doc.toString()).toBe('checklist text'));
    expect(b.fileRequests).toEqual([
      '/api/skills/code-review/files/references/checklist.md?version=4',
    ]);
    typeInEditor(editorView(), '!');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(b.sent).toHaveLength(1));
    expect(keep(b.sent[0])).toEqual(['SKILL.md', 'assets/logo.png']);
    expect(b.sent[0]?.parts).toEqual({ 'references/checklist.md': 'checklist text!' });
  });

  it('starts from the fresh version, not a stale cached one', async () => {
    const b = backend();
    const { user } = renderWithApp(routes, { route: '/skills/code-review' });
    expect(await screen.findByRole('heading', { level: 1, name: 'code-review' })).toBeTruthy();
    // The skill page cached version 4; meanwhile someone saved version 5.
    b.current = { ...v4, version: 5, skillMd: SKILL_MD.replace('# Code review', '# Fresh') };
    await user.click(screen.getByRole('link', { name: 'Edit' }));
    await waitFor(() => expect(editorView().state.doc.toString()).toContain('# Fresh'));
    typeInEditor(editorView(), '!');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(b.sent).toHaveLength(1));
    expect(b.sent[0]?.fields['baseVersion']).toBe('5');
  });

  it('shows server errors by code', async () => {
    const b = backend();
    b.saveAnswers.push(() => errorResponse(422, 'name_mismatch', 'name must equal slug'));
    const { user, router } = renderEdit();
    typeInEditor(await findEditor(), 'x');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByText('The name field in SKILL.md must match the slug')).toBeTruthy();
    expect(router.state.location.pathname).toBe('/skills/code-review/edit');
  });

  it('invalid_frontmatter shows the server message as a detail under the generic text', async () => {
    const b = backend();
    b.saveAnswers.push(() =>
      errorResponse(
        422,
        'invalid_frontmatter',
        'frontmatter "description" must be a non-empty string',
      ),
    );
    const { user } = renderEdit();
    typeInEditor(await findEditor(), 'x');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('SKILL.md must start with a frontmatter block');
    expect(
      within(alert).getByText('frontmatter "description" must be a non-empty string'),
    ).toBeTruthy();
  });

  it('on 409 keeps the edits, shows the banner and saves over version N', async () => {
    const b = backend();
    // Meanwhile someone saved version 6 without the checklist (a small text file: it is
    // re-sent from version 4).
    b.saveAnswers.push(() => {
      b.current = {
        ...v4,
        version: 6,
        files: v4.files.filter((f) => f.path !== 'references/checklist.md'),
      };
      return errorResponse(409, 'version_conflict');
    });
    const { user, router } = renderEdit();
    const view = await findEditor();
    typeInEditor(view, 'mine');
    const text = view.state.doc.toString();
    await user.click(screen.getByRole('button', { name: 'Save' }));

    expect(
      await screen.findByText('The skill was changed while you were editing (version 6).'),
    ).toBeTruthy();
    const diff = screen.getByRole('link', { name: 'View changes' });
    expect(diff.getAttribute('href')).toBe('/skills/code-review/diff?from=4&to=6');
    expect(diff.getAttribute('target')).toBe('_blank');
    expect(editorView().state.doc.toString()).toBe(text);

    await user.click(screen.getByRole('button', { name: 'Save over version 6' }));
    await waitFor(() => expect(b.sent).toHaveLength(2));
    const retry = b.sent[1];
    expect(retry?.fields['baseVersion']).toBe('6');
    expect(keep(retry)).toEqual(['assets/logo.png']);
    expect(retry?.parts).toEqual({
      'SKILL.md': text,
      'references/checklist.md': 'checklist text',
    });
    expect(b.fileRequests).toContain(
      '/api/skills/code-review/files/references/checklist.md?version=4',
    );
    await waitFor(() => expect(router.state.location.pathname).toBe('/skills/code-review'));
  });

  it('on 409 with a kept binary file gone in N explains it and sends nothing', async () => {
    const b = backend();
    b.saveAnswers.push(() => {
      b.current = {
        ...v4,
        version: 5,
        files: v4.files.filter((f) => f.path !== 'assets/logo.png'),
      };
      return errorResponse(409, 'version_conflict');
    });
    const { user } = renderEdit();
    typeInEditor(await findEditor(), 'mine');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await user.click(await screen.findByRole('button', { name: 'Save over version 5' }));
    expect(
      await screen.findByText(
        'Version 5 has no files: assets/logo.png. Upload them again or remove them from the set.',
      ),
    ).toBeTruthy();
    expect(b.sent).toHaveLength(1);
  });

  it('saving over N keeps the files N added; files we removed stay removed', async () => {
    const b = backend();
    b.saveAnswers.push(() => {
      b.current = {
        ...v4,
        version: 6,
        files: [...v4.files, { path: 'extra.md', size: 5, binary: false, sha256: '0'.repeat(64) }],
      };
      return errorResponse(409, 'version_conflict');
    });
    const { user } = renderEdit();
    typeInEditor(await findEditor(), 'mine');
    await user.click(screen.getByRole('button', { name: 'Remove references/checklist.md' }));
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await user.click(await screen.findByRole('button', { name: 'Save over version 6' }));
    await waitFor(() => expect(b.sent).toHaveLength(2));
    expect(keep(b.sent[1])).toEqual(['assets/logo.png', 'extra.md']);
    expect(Object.keys(b.sent[1]?.parts ?? {})).toEqual(['SKILL.md']);
  });

  it('after moving to N a kept SKILL.md is read from N, not from the cached old base', async () => {
    const b = backend();
    b.saveAnswers.push(() => {
      b.current = { ...v4, version: 6 };
      return errorResponse(409, 'version_conflict');
    });
    b.saveAnswers.push(() => errorResponse(422, 'limit_exceeded'));
    const { user } = renderEdit();
    await findEditor();
    await user.click(screen.getByRole('button', { name: /^references\/checklist\.md/ }));
    await waitFor(() => expect(editorView().state.doc.toString()).toBe('checklist text'));
    typeInEditor(editorView(), '!');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await user.click(await screen.findByRole('button', { name: 'Save over version 6' }));
    expect(await screen.findByText(/^Limit exceeded/)).toBeTruthy();
    expect(keep(b.sent[1])).toEqual(['SKILL.md', 'assets/logo.png']);

    await user.click(screen.getByRole('button', { name: /^SKILL\.md/ }));
    await waitFor(() =>
      expect(b.fileRequests).toContain('/api/skills/code-review/files/SKILL.md?version=6'),
    );
  });

  it('keeps the same editor (focus, caret, history) through the first edit of a kept file', async () => {
    backend();
    const { user } = renderEdit();
    await findEditor();
    await user.click(screen.getByRole('button', { name: /^references\/checklist\.md/ }));
    await waitFor(() => expect(editorView().state.doc.toString()).toBe('checklist text'));
    const view = editorView();
    typeInEditor(view, 'a');
    expect(
      screen.getByRole('button', { name: /^references\/checklist\.md\s*modified/ }),
    ).toBeTruthy();
    typeInEditor(view, 'b');
    expect(editorView()).toBe(view);
    expect(view.state.doc.toString()).toBe('checklist textab');
  });

  it("does not show another user's draft", async () => {
    backend();
    sessionStorage.setItem(
      'draft:code-review',
      JSON.stringify({
        user: 'alice',
        slug: 'code-review',
        baseVersion: 4,
        message: 'secret',
        files: [{ path: 'SKILL.md', kind: 'text', text: 'alice private text', size: 18 }],
        reupload: [],
      }),
    );
    renderEdit();
    expect((await findEditor()).state.doc.toString()).toBe(SKILL_MD);
    expect(screen.queryByText('Unsaved draft restored')).toBeNull();
    expect(sessionStorage.getItem('draft:code-review')).toBeNull();
  });

  it('"Sign out" from a dirty editor asks first; after logout no draft is left', async () => {
    backend();
    sessionStorage.setItem('draft:other', '{}');
    const { user, router } = renderEdit();
    typeInEditor(await findEditor(), 'unsaved');
    await waitFor(() => expect(loadDraft('code-review', 'admin')).not.toBeNull(), {
      timeout: 2000,
    });

    const nav = screen.getAllByRole('button', { name: 'admin' })[0];
    if (!nav) throw new Error('no user menu');
    await user.click(nav);
    await user.click(await screen.findByRole('menuitem', { name: 'Sign out' }));
    const dialog = await screen.findByRole('alertdialog');
    expect(within(dialog).getByText('Leave without saving?')).toBeTruthy();
    await user.click(within(dialog).getByRole('button', { name: 'Sign out' }));

    await waitFor(() => expect(router.state.location.pathname).toBe('/login'));
    expect(Object.keys(sessionStorage).filter((k) => k.startsWith('draft:'))).toEqual([]);
  });

  it('on 401 goes to login with next; after signing in the draft is restored', async () => {
    const b = backend();
    b.saveAnswers.push(() => errorResponse(401, 'unauthenticated'));
    const { user, router } = renderEdit();
    typeInEditor(await findEditor(), 'unsaved words');
    await user.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(router.state.location.pathname).toBe('/login'));
    expect(router.state.location.search).toBe(
      `?next=${encodeURIComponent('/skills/code-review/edit')}`,
    );
    expect(
      loadDraft('code-review', 'admin')?.files.find((f) => f.path === 'SKILL.md'),
    ).toMatchObject({
      kind: 'text',
      text: `${SKILL_MD}unsaved words`,
    });

    await user.type(await screen.findByLabelText('Username'), 'admin');
    await user.type(screen.getByLabelText('Password'), 'secret');
    await user.click(screen.getByRole('button', { name: 'Sign in' }));

    await waitFor(() => expect(router.state.location.pathname).toBe('/skills/code-review/edit'));
    expect(await screen.findByText('Unsaved draft restored')).toBeTruthy();
    expect((await findEditor()).state.doc.toString()).toBe(`${SKILL_MD}unsaved words`);
  });

  it('stores the draft 500 ms after a change', async () => {
    backend();
    renderEdit();
    typeInEditor(await findEditor(), 'draft me');
    expect(loadDraft('code-review', 'admin')).toBeNull();
    await waitFor(
      () =>
        expect(
          loadDraft('code-review', 'admin')?.files.find((f) => f.kind === 'text'),
        ).toBeTruthy(),
      { timeout: 2000 },
    );
  });

  it('asks before leaving with unsaved changes', async () => {
    backend();
    const { user, router } = renderEdit();
    typeInEditor(await findEditor(), 'x');

    await user.click(screen.getByRole('link', { name: 'Cancel' }));
    const dialog = await screen.findByRole('alertdialog');
    expect(within(dialog).getByText('Leave without saving?')).toBeTruthy();
    await user.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
    expect(router.state.location.pathname).toBe('/skills/code-review/edit');

    await user.click(screen.getByRole('link', { name: 'Cancel' }));
    await user.click(
      within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Leave' }),
    );
    await waitFor(() => expect(router.state.location.pathname).toBe('/skills/code-review'));
    expect(loadDraft('code-review', 'admin')).toBeNull();
  });

  it('leaves without asking when nothing changed', async () => {
    backend();
    const { user, router } = renderEdit();
    await findEditor();
    await user.click(screen.getByRole('link', { name: 'Cancel' }));
    await waitFor(() => expect(router.state.location.pathname).toBe('/skills/code-review'));
    expect(screen.queryByRole('alertdialog')).toBeNull();
  });
});

describe('creating a skill', () => {
  it('starts from the template, follows the slug and creates the skill', async () => {
    const b = backend();
    const { user, router } = renderWithApp(routes, { route: '/skills/new?folder=devops' });
    expect(await screen.findByRole('heading', { level: 1, name: 'New skill' })).toBeTruthy();
    expect(screen.getByText(/Lowercase Latin letters, digits and hyphens/)).toBeTruthy();

    await user.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByText('Enter a slug')).toBeTruthy();
    expect(b.sent).toHaveLength(0);

    await user.type(screen.getByLabelText('Slug'), 'my-skill');
    const md = (await findEditor()).state.doc.toString();
    expect(md).toContain('name: my-skill\n');
    // A placeholder the server accepts: an empty `description:` is invalid frontmatter.
    expect(md).toMatch(/\ndescription: \S.*\n/);
    await user.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(router.state.location.pathname).toBe('/skills/my-skill'));
    const [sent] = b.sent;
    expect(sent?.method).toBe('POST');
    expect(sent?.url).toBe('/api/skills');
    expect(sent?.fields['slug']).toBe('my-skill');
    expect(sent?.fields['folder']).toBe('devops');
    expect(sent?.fields['keep']).toBeUndefined();
    expect(sent?.fields['baseVersion']).toBeUndefined();
    expect(sent?.parts['SKILL.md']).toBe(md);
    expect(await screen.findByText('Skill created')).toBeTruthy();
    expect(loadDraft('new', 'admin')).toBeNull();
  });

  it('restores a stored new-skill draft and asks to upload files again', async () => {
    backend();
    sessionStorage.setItem(
      'draft:new',
      JSON.stringify({
        user: 'admin',
        slug: 'half-done',
        message: '',
        files: [{ path: 'SKILL.md', kind: 'text', text: 'draft body', size: 10 }],
        reupload: ['assets/a.png'],
      }),
    );
    renderWithApp(routes, { route: '/skills/new' });
    expect(await screen.findByText('Unsaved draft restored')).toBeTruthy();
    expect(screen.getByText('Upload these files again: assets/a.png')).toBeTruthy();
    expect(screen.getByLabelText<HTMLInputElement>('Slug').value).toBe('half-done');
    expect((await findEditor()).state.doc.toString()).toBe('draft body');
  });

  it('preselects an active folder from ?folder=', async () => {
    backend();
    renderWithApp(routes, { route: '/skills/new?folder=devops' });
    const select = await screen.findByRole('combobox', { name: 'Folder' });
    await waitFor(() => expect(select.textContent).toContain('DevOps'));
  });

  it('without a folder says "Select a folder" and sends nothing', async () => {
    const b = backend();
    const { user } = renderWithApp(routes, { route: '/skills/new' });
    await screen.findByRole('combobox', { name: 'Folder' });
    await user.type(screen.getByLabelText('Slug'), 'my-skill');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    expect((await screen.findByRole('alert')).textContent).toBe('Select a folder');
    expect(b.sent).toHaveLength(0);
  });

  it('a chosen folder is sent', async () => {
    const b = backend();
    const { user, router } = renderWithApp(routes, { route: '/skills/new' });
    await user.click(await screen.findByRole('combobox', { name: 'Folder' }));
    await user.click(await screen.findByRole('option', { name: 'DevOps' }));
    await user.type(screen.getByLabelText('Slug'), 'my-skill');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(router.state.location.pathname).toBe('/skills/my-skill'));
    expect(b.sent[0]?.fields['folder']).toBe('devops');
  });

  it('folder_archived is shown under the folder field and the edits stay', async () => {
    const b = backend();
    b.saveAnswers.push(() => errorResponse(409, 'folder_archived'));
    const { user } = renderWithApp(routes, { route: '/skills/new?folder=devops' });
    await user.type(await screen.findByLabelText('Slug'), 'my-skill');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    const alert = await screen.findByText('Folder is archived: choose another one');
    expect(alert.id).toBe('skill-folder-error');
    expect(screen.getByLabelText<HTMLInputElement>('Slug').value).toBe('my-skill');
  });

  it('without active folders offers "Create folder" instead of the form', async () => {
    backend();
    server.use(foldersHandler([oldFolder]));
    renderWithApp(routes, { route: '/skills/new' });
    const link = await screen.findByRole('link', { name: 'Create folder' });
    expect(link.getAttribute('href')).toBe('/folders/new');
    expect(screen.queryByLabelText('Slug')).toBeNull();
  });

  it('restores the folder of a stored draft', async () => {
    backend();
    sessionStorage.setItem(
      'draft:new',
      JSON.stringify({
        user: 'admin',
        slug: 'half-done',
        folder: 'devops',
        message: '',
        files: [{ path: 'SKILL.md', kind: 'text', text: 'draft body', size: 10 }],
        reupload: [],
      }),
    );
    renderWithApp(routes, { route: '/skills/new' });
    const select = await screen.findByRole('combobox', { name: 'Folder' });
    await waitFor(() => expect(select.textContent).toContain('DevOps'));
  });

  it('editing an existing skill shows no folder field and sends none', async () => {
    const b = backend();
    renderWithApp(routes, { route: '/skills/code-review/edit' });
    await findEditor();
    expect(screen.queryByRole('combobox', { name: 'Folder' })).toBeNull();
    expect(b.sent).toHaveLength(0);
  });
});
