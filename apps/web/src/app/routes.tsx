import { Navigate, Outlet, type RouteObject } from 'react-router';
import { AuthProvider } from '@/auth/AuthProvider.tsx';
import { LoginPage } from '@/auth/LoginPage.tsx';
import { RequireAdmin, RequireAuth } from '@/auth/RequireAuth.tsx';
import { EmptyState } from '@/components/EmptyState.tsx';
import { EditorPage } from '@/editor/EditorPage.tsx';
import { useSystemTheme } from '@/lib/useSystemTheme.ts';
import { FolderFormPage } from '@/folders/FolderFormPage.tsx';
import { FoldersPage } from '@/folders/FoldersPage.tsx';
import { DiffPage } from '@/history/DiffView.tsx';
import { HistoryPage } from '@/history/HistoryPage.tsx';
import { SkillPage } from '@/skills/SkillPage.tsx';
import { SkillsListPage } from '@/skills/SkillsListPage.tsx';
import { strings } from '@/strings.ts';
import { TokensPage } from '@/tokens/TokensPage.tsx';
import { UsersPage } from '@/users/UsersPage.tsx';
import { Layout } from './Layout.tsx';

/** Root route: theme sync and session state for every page, login included. */
function Root() {
  useSystemTheme();
  return (
    <AuthProvider>
      <Outlet />
    </AuthProvider>
  );
}

/** The app's routes. `/skills/:slug/diff` reads `?from=&to=` from the search string. */
export const routes: RouteObject[] = [
  {
    element: <Root />,
    children: [
      { path: '/login', element: <LoginPage /> },
      {
        element: <RequireAuth />,
        children: [
          {
            element: <Layout />,
            children: [
              { index: true, element: <Navigate to="/skills" replace /> },
              { path: 'skills', element: <SkillsListPage /> },
              { path: 'skills/new', element: <EditorPage /> },
              { path: 'skills/:slug', element: <SkillPage /> },
              { path: 'skills/:slug/edit', element: <EditorPage /> },
              { path: 'skills/:slug/history', element: <HistoryPage /> },
              { path: 'skills/:slug/diff', element: <DiffPage /> },
              { path: 'folders', element: <FoldersPage /> },
              { path: 'folders/new', element: <FolderFormPage /> },
              { path: 'folders/:slug/edit', element: <FolderFormPage /> },
              { path: 'tokens', element: <TokensPage /> },
              {
                path: 'users',
                element: (
                  <RequireAdmin>
                    <UsersPage />
                  </RequireAdmin>
                ),
              },
              { path: '*', element: <EmptyState title={strings.access.notFound} /> },
            ],
          },
        ],
      },
    ],
  },
];
