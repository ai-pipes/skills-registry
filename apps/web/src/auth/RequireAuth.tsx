import type { ReactNode } from 'react';
import { Navigate, Outlet, useLocation } from 'react-router';
import { EmptyState } from '@/components/EmptyState.tsx';
import { Skeleton } from '@/components/ui/skeleton';
import { strings } from '@/strings.ts';
import { loginPath, useAuth } from './AuthProvider.tsx';

/** Layout route: renders its children only for a signed-in user, else sends them to login. */
export function RequireAuth() {
  const { status, loggedOut } = useAuth();
  const { pathname, search } = useLocation();
  if (status === 'loading') {
    return (
      <div aria-busy="true" className="flex flex-col gap-3 p-6">
        <span className="sr-only">{strings.common.loading}</span>
        <Skeleton className="h-8 w-48" />
        <Skeleton className="h-4 w-full max-w-md" />
      </div>
    );
  }
  if (status === 'signed-out') {
    // After an explicit logout there is nothing to return to: plain /login, no ?next=.
    return <Navigate to={loggedOut ? '/login' : loginPath(pathname + search)} replace />;
  }
  return <Outlet />;
}

/** Admin-only content; others get "Access denied". Use inside `RequireAuth`. */
export function RequireAdmin({ children }: { children: ReactNode }) {
  const { me } = useAuth();
  if (me?.role !== 'admin') {
    return (
      <EmptyState title={strings.access.forbidden} description={strings.access.forbiddenHint} />
    );
  }
  return children;
}
