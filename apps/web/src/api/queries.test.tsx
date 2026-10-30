import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderHook, waitFor } from '@testing-library/react';
import type { FileDiff, TokenSummary, UserSummary, VersionSummary } from '@skills/contracts';
import { http, HttpResponse } from 'msw';
import type { ReactNode } from 'react';
import { describe, expect, it } from 'vite-plus/test';
import { server } from '../../test/msw/handlers.ts';
import { devopsFolder, generalFolder, skillSummary } from '../../test/fixtures.ts';
import {
  queryKeys,
  useArchiveFolder,
  useDiff,
  useFolders,
  useHistory,
  useMoveSkill,
  useRestoreSkillTo,
  useSkills,
  useTokens,
  useUsers,
} from './queries.ts';

function wrapper() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
}

const at = '2026-10-28T12:00:00.000Z';

describe('queries for later sections', () => {
  it('query keys put every skill query under ["skill", slug] and lists under ["skills"]', () => {
    expect(queryKeys.skillList('active', '', null)).toEqual(['skills', 'active', '', null]);
    expect(queryKeys.folderList('all')).toEqual(['folders', 'all']);
    for (const key of [
      queryKeys.skillView('a', 2),
      queryKeys.skillFile('a', 'x/y.md', undefined),
      queryKeys.history('a'),
      queryKeys.diff('a', 1, 2),
    ]) {
      expect(key.slice(0, 2)).toEqual(queryKeys.skill('a'));
    }
  });

  it('useHistory and useDiff call the skill endpoints with an encoded slug', async () => {
    const history: VersionSummary[] = [
      {
        number: 1,
        authorId: 'u1',
        authorLogin: 'admin',
        message: null,
        createdAt: at,
        restoredFrom: null,
        sourceCommit: null,
      },
    ];
    const diff: FileDiff[] = [{ path: 'SKILL.md', status: 'modified', patch: '@@' }];
    let diffQuery = '';
    server.use(
      http.get('/api/skills/a%20b/history', () => HttpResponse.json(history)),
      http.get('/api/skills/a%20b/diff', ({ request }) => {
        diffQuery = new URL(request.url).search;
        return HttpResponse.json(diff);
      }),
    );
    const h = renderHook(() => useHistory('a b'), { wrapper: wrapper() });
    await waitFor(() => expect(h.result.current.data).toEqual(history));
    const d = renderHook(() => useDiff('a b', 1, 3), { wrapper: wrapper() });
    await waitFor(() => expect(d.result.current.data).toEqual(diff));
    expect(diffQuery).toBe('?from=1&to=3');
  });

  it('useTokens and useUsers list tokens and users', async () => {
    const tokens: TokenSummary[] = [
      { id: 't', name: 'dev', prefix: 'sk_ab', createdAt: at, lastUsedAt: null, revokedAt: null },
    ];
    const users: UserSummary[] = [
      {
        id: 'u',
        login: 'admin',
        role: 'admin',
        disabled: false,
        createdAt: at,
        sso: true,
        email: 'admin@example.com',
        lastLoginAt: null,
      },
    ];
    server.use(
      http.get('/api/tokens', () => HttpResponse.json(tokens)),
      http.get('/api/users', () => HttpResponse.json(users)),
    );
    const t = renderHook(() => useTokens(), { wrapper: wrapper() });
    const u = renderHook(() => useUsers(), { wrapper: wrapper() });
    await waitFor(() => expect(t.result.current.data).toEqual(tokens));
    await waitFor(() => expect(u.result.current.data).toEqual(users));
  });
});

describe('folder queries and mutations', () => {
  it('useFolders sends the status and parses the list', async () => {
    let search = '';
    server.use(
      http.get('/api/folders', ({ request }) => {
        search = new URL(request.url).search;
        return HttpResponse.json([generalFolder, devopsFolder]);
      }),
    );
    const h = renderHook(() => useFolders('all'), { wrapper: wrapper() });
    await waitFor(() => expect(h.result.current.data).toEqual([generalFolder, devopsFolder]));
    expect(search).toBe('?status=all');
  });

  it('useSkills sends folder only when set', async () => {
    const searches: string[] = [];
    server.use(
      http.get('/api/skills', ({ request }) => {
        searches.push(new URL(request.url).search);
        return HttpResponse.json([skillSummary]);
      }),
    );
    const a = renderHook(() => useSkills({ status: 'active', q: '', folder: 'devops' }), {
      wrapper: wrapper(),
    });
    await waitFor(() => expect(a.result.current.data).toEqual([skillSummary]));
    const b = renderHook(() => useSkills({ status: 'active', q: '' }), { wrapper: wrapper() });
    await waitFor(() => expect(b.result.current.data).toEqual([skillSummary]));
    expect(searches).toEqual(['?status=active&folder=devops', '?status=active']);
  });

  it('useMoveSkill and useRestoreSkillTo post the target folder', async () => {
    const calls: string[] = [];
    server.use(
      http.post('/api/skills/code-review/move', async ({ request }) => {
        calls.push(`move ${await request.text()}`);
        return new HttpResponse(null, { status: 204 });
      }),
      http.post('/api/skills/code-review/restore', async ({ request }) => {
        calls.push(`restore ${await request.text()}`);
        return new HttpResponse(null, { status: 204 });
      }),
    );
    const move = renderHook(() => useMoveSkill('code-review'), { wrapper: wrapper() });
    move.result.current.mutate('devops');
    await waitFor(() => expect(move.result.current.isSuccess).toBe(true));
    const restore = renderHook(() => useRestoreSkillTo('code-review'), { wrapper: wrapper() });
    restore.result.current.mutate('devops');
    await waitFor(() => expect(restore.result.current.isSuccess).toBe(true));
    expect(calls).toEqual(['move {"folder":"devops"}', 'restore {"folder":"devops"}']);
  });

  it('useArchiveFolder returns the count and refetches skill lists', async () => {
    let skillRequests = 0;
    server.use(
      http.get('/api/skills', () => {
        skillRequests += 1;
        return HttpResponse.json([skillSummary]);
      }),
      http.post('/api/folders/devops/archive', () => HttpResponse.json({ archivedSkills: 3 })),
    );
    const h = renderHook(
      () => ({
        skills: useSkills({ status: 'active', q: '' }),
        archive: useArchiveFolder('devops'),
      }),
      { wrapper: wrapper() },
    );
    await waitFor(() => expect(h.result.current.skills.data).toBeDefined());
    expect(skillRequests).toBe(1);
    h.result.current.archive.mutate();
    await waitFor(() => expect(h.result.current.archive.data).toEqual({ archivedSkills: 3 }));
    await waitFor(() => expect(skillRequests).toBe(2));
  });
});
