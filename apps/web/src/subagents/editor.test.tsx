import { EditorView } from '@codemirror/view';
import { act, screen, waitFor, within } from '@testing-library/react';
import type { SubagentView, VersionRef } from '@skills/contracts';
import { delay, http, HttpResponse } from 'msw';
import { z } from 'zod';
import { describe, expect, it } from 'vite-plus/test';
import { routes } from '@/app/routes.tsx';
import { skillSummary, subagentView } from '../../test/fixtures.ts';
import { errorResponse, server } from '../../test/msw/handlers.ts';
import { renderWithApp } from '../../test/setup.ts';

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

async function readBody(request: Request): Promise<Record<string, unknown>> {
  return z.record(z.string(), z.unknown()).parse(await request.json());
}

interface Sent {
  method: string;
  url: string;
  body: Record<string, unknown>;
}

/** Subagent endpoints; saves are recorded, and answered by `answers` first (then with success). */
function backend(current: SubagentView = subagentView) {
  const sent: Sent[] = [];
  const answers: (() => Response)[] = [];
  const answer = (slug: string, version: number) => {
    const next = answers.shift();
    if (next) return next();
    const ref: VersionRef = { slug, version };
    return HttpResponse.json(ref, { status: 201 });
  };
  server.use(
    http.get('/api/subagents/:slug', ({ params }) =>
      params.slug === current.slug
        ? HttpResponse.json(current)
        : errorResponse(404, 'subagent_not_found'),
    ),
    http.post('/api/subagents', async ({ request }) => {
      const body = await readBody(request);
      sent.push({ method: 'POST', url: '/api/subagents', body });
      return answer(String(body['slug']), 1);
    }),
    http.put('/api/subagents/:slug', async ({ request, params }) => {
      const body = await readBody(request);
      sent.push({ method: 'PUT', url: `/api/subagents/${String(params['slug'])}`, body });
      return answer(String(params['slug']), Number(body['baseVersion']) + 1);
    }),
    http.get('/api/skills', ({ request }) => {
      const q = new URL(request.url).searchParams.get('q') ?? '';
      return HttpResponse.json(q === '' ? [] : [skillSummary]);
    }),
  );
  return { sent, answers };
}

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

function setEditorText(view: EditorView, text: string) {
  act(() => {
    view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: text } });
  });
}

const NEW = '/subagents/new';
const EXPECTED_HOSTILE =
  '---\nname: code-reviewer\ndescription: |-\n  Use when: "quoted" # x\n  second line\nmodel: sonnet\n---\n---\nnot frontmatter\n---\ntext\n';
const EDIT = '/subagents/code-reviewer/edit';

async function fillNew(user: ReturnType<typeof renderWithApp>['user'], slug = 'devops') {
  await user.type(await screen.findByLabelText('Slug'), slug);
  await user.click(screen.getByRole('combobox', { name: 'Folder' }));
  await user.click(await screen.findByRole('option', { name: 'General' }));
}

describe('creating a subagent', () => {
  it('sends POST /api/subagents with the serialized SUBAGENT.md', async () => {
    const b = backend();
    const { user, router } = renderWithApp(routes, { route: NEW });
    await fillNew(user);
    await user.type(screen.getByLabelText('Description'), 'Use for Dockerfiles: infra.');
    await user.type(screen.getByLabelText('Prompt'), 'You are DevOps.');
    await user.click(screen.getByRole('checkbox', { name: 'Inherit all tools' }));
    await user.click(screen.getByRole('checkbox', { name: 'Bash' }));
    await user.type(screen.getByLabelText('Other tool'), 'mcp__github__create_pull_request');
    await user.click(screen.getByRole('button', { name: 'Add tool' }));
    await user.type(screen.getByLabelText('Change message'), 'first');
    await user.click(screen.getByRole('button', { name: 'Publish' }));

    await waitFor(() => expect(router.state.location.pathname).toBe('/subagents/devops'));
    expect(b.sent).toEqual([
      {
        method: 'POST',
        url: '/api/subagents',
        body: {
          slug: 'devops',
          folder: 'general',
          message: 'first',
          content:
            '---\nname: devops\ndescription: "Use for Dockerfiles: infra."\ntools:\n  - Bash\n  - mcp__github__create_pull_request\n---\nYou are DevOps.',
        },
      },
    ]);
  });

  it('puts the unknown_skill error under Skills', async () => {
    const b = backend();
    b.answers.push(() => errorResponse(422, 'unknown_skill', 'unknown skill "ghost"'));
    const { user } = renderWithApp(routes, { route: NEW });
    await fillNew(user);
    await user.type(screen.getByLabelText('Description'), 'd');
    await user.click(screen.getByRole('button', { name: 'Publish' }));

    const skills = await screen.findByRole('group', { name: 'Skills' });
    expect(await within(skills).findByText(/does not exist or is archived/)).toBeTruthy();
    expect(within(skills).getByText(/ghost/)).toBeTruthy();
  });

  it('puts an invalid_frontmatter error about tools under Tools', async () => {
    const b = backend();
    b.answers.push(() =>
      errorResponse(422, 'invalid_frontmatter', 'frontmatter "tools" has an invalid tool name "x"'),
    );
    const { user } = renderWithApp(routes, { route: NEW });
    await fillNew(user);
    await user.click(screen.getByRole('button', { name: 'Publish' }));

    const tools = await screen.findByRole('group', { name: 'Tools' });
    expect(await within(tools).findByText(/invalid tool name/)).toBeTruthy();
  });

  it('shows other server errors above the form', async () => {
    const b = backend();
    b.answers.push(() => errorResponse(409, 'subagent_exists'));
    const { user } = renderWithApp(routes, { route: NEW });
    await fillNew(user);
    await user.click(screen.getByRole('button', { name: 'Publish' }));
    expect(await screen.findByText('A subagent with this slug already exists')).toBeTruthy();
  });

  it('blocks Publish when "Inherit all tools" is off and no tool is selected', async () => {
    const b = backend();
    const { user } = renderWithApp(routes, { route: NEW });
    await fillNew(user);
    await user.click(screen.getByRole('checkbox', { name: 'Inherit all tools' }));
    const publish = screen.getByRole('button', { name: 'Publish' });
    expect(publish.hasAttribute('disabled')).toBe(true);
    expect(screen.getByText('Select at least one tool, or inherit all tools')).toBeTruthy();
    await user.click(publish);
    expect(b.sent).toEqual([]);

    await user.click(screen.getByRole('checkbox', { name: 'Read' }));
    expect(screen.getByRole('button', { name: 'Publish' }).hasAttribute('disabled')).toBe(false);
  });

  it('rejects an invalid free-entry tool and adds skills from the autocomplete', async () => {
    const b = backend();
    const { user } = renderWithApp(routes, { route: NEW });
    await fillNew(user);
    await user.click(screen.getByRole('checkbox', { name: 'Inherit all tools' }));
    await user.type(screen.getByLabelText('Other tool'), 'mcp__github__*');
    await user.click(screen.getByRole('button', { name: 'Add tool' }));
    expect(
      screen.getByText('A tool is a name like Read or an MCP tool like mcp__server__tool'),
    ).toBeTruthy();

    await user.type(screen.getByRole('textbox', { name: 'Skills' }), 'review');
    await user.click(await screen.findByRole('button', { name: /code-review/ }));
    expect(screen.getByRole('button', { name: 'Remove code-review' })).toBeTruthy();
    expect(b.sent).toEqual([]);
  });
});

describe('field errors and fields', () => {
  it('editing Skills dismisses the unknown_skill error under it', async () => {
    const b = backend();
    b.answers.push(() => errorResponse(422, 'unknown_skill', 'unknown skill "ghost"'));
    const { user } = renderWithApp(routes, { route: NEW });
    await fillNew(user);
    await user.click(screen.getByRole('button', { name: 'Publish' }));
    const skills = await screen.findByRole('group', { name: 'Skills' });
    expect(await within(skills).findByText(/ghost/)).toBeTruthy();

    await user.type(screen.getByRole('textbox', { name: 'Skills' }), 'review');
    await user.click(await screen.findByRole('button', { name: /code-review/ }));
    expect(within(skills).queryByText(/ghost/)).toBeNull();
  });

  it('editing Tools dismisses the tools error under it', async () => {
    const b = backend();
    b.answers.push(() =>
      errorResponse(422, 'invalid_frontmatter', 'frontmatter "tools" has an invalid tool name "x"'),
    );
    const { user } = renderWithApp(routes, { route: NEW });
    await fillNew(user);
    await user.click(screen.getByRole('checkbox', { name: 'Inherit all tools' }));
    await user.click(screen.getByRole('checkbox', { name: 'Read' }));
    await user.click(screen.getByRole('button', { name: 'Publish' }));
    const tools = await screen.findByRole('group', { name: 'Tools' });
    expect(await within(tools).findByText(/invalid tool name/)).toBeTruthy();

    await user.click(screen.getByRole('checkbox', { name: 'Bash' }));
    expect(within(tools).queryByText(/invalid tool name/)).toBeNull();
  });

  it('changing the Folder dismisses the folder error under it', async () => {
    const b = backend();
    b.answers.push(() => errorResponse(409, 'folder_archived'));
    const { user } = renderWithApp(routes, { route: NEW });
    await fillNew(user);
    await user.click(screen.getByRole('button', { name: 'Publish' }));
    expect(await screen.findByText(/Folder is archived/)).toBeTruthy();

    await user.click(screen.getByRole('combobox', { name: 'Folder' }));
    await user.click(await screen.findByRole('option', { name: 'DevOps' }));
    expect(screen.queryByText(/Folder is archived/)).toBeNull();
  });

  it('the visible Folder label is bound to the picker', async () => {
    backend();
    renderWithApp(routes, { route: NEW });
    const labelled = await screen.findByLabelText('Folder');
    expect(labelled.getAttribute('role')).toBe('combobox');
  });

  it('switching "Inherit all tools" on and off restores the previous selection', async () => {
    backend();
    const { user } = renderWithApp(routes, { route: NEW });
    await fillNew(user);
    await user.click(screen.getByRole('checkbox', { name: 'Inherit all tools' }));
    await user.click(screen.getByRole('checkbox', { name: 'Bash' }));
    await user.click(screen.getByRole('checkbox', { name: 'Read' }));
    await user.click(screen.getByRole('checkbox', { name: 'Inherit all tools' }));
    expect(screen.queryByRole('checkbox', { name: 'Bash' })).toBeNull();
    await user.click(screen.getByRole('checkbox', { name: 'Inherit all tools' }));
    expect(screen.getByRole('checkbox', { name: 'Bash' }).getAttribute('aria-checked')).toBe(
      'true',
    );
    expect(screen.getByRole('checkbox', { name: 'Read' }).getAttribute('aria-checked')).toBe(
      'true',
    );
    expect(screen.getByRole('checkbox', { name: 'Grep' }).getAttribute('aria-checked')).toBe(
      'false',
    );
  });

  it('does not list skills until something is typed, and keeps suggestions while a new query loads', async () => {
    const queries: string[] = [];
    backend();
    server.use(
      http.get('/api/skills', async ({ request }) => {
        const q = new URL(request.url).searchParams.get('q') ?? '';
        queries.push(q);
        if (q === 'reviews') await delay(600);
        return HttpResponse.json([skillSummary]);
      }),
    );
    const { user } = renderWithApp(routes, { route: NEW });
    await fillNew(user);
    expect(queries).toEqual([]);

    const box = screen.getByRole('textbox', { name: 'Skills' });
    await user.type(box, 'review');
    await screen.findByRole('button', { name: /code-review/ });
    await user.type(box, 's');
    await waitFor(() => expect(queries).toContain('reviews'));
    expect(screen.getByRole('button', { name: /code-review/ })).toBeTruthy();
    expect(queries).not.toContain('');
  });
});

describe('Form and Raw tabs', () => {
  it('Raw text with an unknown key cannot switch to Form and shows the error', async () => {
    backend();
    const { user } = renderWithApp(routes, { route: EDIT });
    await screen.findByLabelText('Description');
    await user.click(screen.getByRole('tab', { name: 'Raw' }));
    setEditorText(
      await findEditor(),
      '---\nname: code-reviewer\ndescription: d\ncolor: red\n---\nbody',
    );
    await user.click(screen.getByRole('tab', { name: 'Form' }));

    expect(
      await screen.findByText(/Cannot switch to the form: unknown frontmatter key "color"/),
    ).toBeTruthy();
    expect(screen.getByRole('tab', { name: 'Raw' }).getAttribute('aria-selected')).toBe('true');
    expect(screen.queryByLabelText('Description')).toBeNull();
  });

  it('a YAML-hostile description and a body starting with --- survive Form to Raw to Form', async () => {
    const b = backend();
    const { user } = renderWithApp(routes, { route: EDIT });
    const description = await screen.findByLabelText('Description');
    const hostile = 'Use when: "quoted" # x';
    await user.clear(description);
    await user.type(description, hostile);
    await user.type(description, '{Enter}second line');
    const prompt = screen.getByLabelText('Prompt');
    await user.clear(prompt);
    await user.type(prompt, '---{Enter}not frontmatter{Enter}---{Enter}text');

    await user.click(screen.getByRole('tab', { name: 'Raw' }));
    const raw = (await findEditor()).state.doc.toString();
    // Edit Raw (a trailing newline) so that the switch back really parses the text.
    setEditorText(editorView(), `${raw}\n`);
    await user.click(screen.getByRole('tab', { name: 'Form' }));

    expect(screen.getByLabelText<HTMLTextAreaElement>('Description').value).toBe(
      `${hostile}\nsecond line`,
    );
    expect(screen.getByLabelText<HTMLTextAreaElement>('Prompt').value).toBe(
      '---\nnot frontmatter\n---\ntext\n',
    );
    await user.click(screen.getByRole('button', { name: 'Publish' }));
    await waitFor(() => expect(b.sent).toHaveLength(1));
    expect(b.sent[0]?.body['content']).toBe(EXPECTED_HOSTILE);
  });
});

describe('editing a subagent whose stored content does not parse', () => {
  it('opens in Raw with the original text and the error, and keeps the Form blocked', async () => {
    const broken = '---\nname: code-reviewer\ntools: [unclosed\n---\nBody.';
    backend({ ...subagentView, content: broken });
    const { user } = renderWithApp(routes, { route: EDIT });
    const view = await findEditor();
    expect(view.state.doc.toString()).toBe(broken);
    expect((await screen.findByText(/Cannot switch to the form/)).textContent).toBeTruthy();
    await user.click(screen.getByRole('tab', { name: 'Form' }));
    expect(screen.queryByLabelText('Description')).toBeNull();
    expect(screen.getByRole('tab', { name: 'Raw' }).getAttribute('aria-selected')).toBe('true');
  });
});

describe('editing a subagent', () => {
  it('publishes on top of the current version', async () => {
    const b = backend();
    const { user, router } = renderWithApp(routes, { route: EDIT });
    expect(await screen.findByLabelText('Description')).toBeTruthy();
    expect(screen.queryByLabelText('Slug')).toBeNull();
    await user.type(screen.getByLabelText('Prompt'), 'More.');
    await user.click(screen.getByRole('button', { name: 'Publish' }));

    await waitFor(() => expect(router.state.location.pathname).toBe('/subagents/code-reviewer'));
    expect(b.sent).toHaveLength(1);
    expect(b.sent[0]?.method).toBe('PUT');
    expect(b.sent[0]?.body['baseVersion']).toBe(2);
    expect(String(b.sent[0]?.body['content'])).toContain('You are a **careful** reviewer.\nMore.');
    expect(String(b.sent[0]?.body['content'])).toContain('model: sonnet');
  });

  it('shows a conflict message on version_conflict', async () => {
    const b = backend();
    b.answers.push(() => errorResponse(409, 'version_conflict'));
    const { user } = renderWithApp(routes, { route: EDIT });
    await user.type(await screen.findByLabelText('Prompt'), 'x');
    await user.click(screen.getByRole('button', { name: 'Publish' }));
    expect(await screen.findByText(/changed while you were editing/)).toBeTruthy();
  });

  it('asks before leaving with unsaved changes, and leaves without asking when clean', async () => {
    backend();
    const { user, router } = renderWithApp(routes, { route: EDIT });
    await user.type(await screen.findByLabelText('Prompt'), 'x');
    await user.click(screen.getByRole('link', { name: 'Cancel' }));
    const dialog = await screen.findByRole('alertdialog');
    expect(within(dialog).getByText('Leave without saving?')).toBeTruthy();
    await user.click(within(dialog).getByRole('button', { name: 'Leave' }));
    await waitFor(() => expect(router.state.location.pathname).toBe('/subagents/code-reviewer'));
  });

  it('leaves without asking when nothing changed', async () => {
    backend();
    const { user, router } = renderWithApp(routes, { route: EDIT });
    await screen.findByLabelText('Description');
    await user.click(screen.getByRole('link', { name: 'Cancel' }));
    await waitFor(() => expect(router.state.location.pathname).toBe('/subagents/code-reviewer'));
    expect(screen.queryByRole('alertdialog')).toBeNull();
  });
});
