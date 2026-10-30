import { MeResponse } from '@skills/contracts';
import { useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';
import { createContext, use, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useLocation, useNavigate } from 'react-router';
import { api, onUnauthorized } from '@/api/client.ts';
import { isApiError } from '@/api/errors.ts';
import { clearAllDrafts, freezeDrafts, unfreezeDrafts } from '@/editor/draft.ts';

export type LoginResult =
  | { ok: true }
  | { ok: false; reason: 'invalid' | 'rate_limited' | 'cookie_blocked'; retryAfterSec?: number };

export interface Auth {
  me: MeResponse | null;
  status: 'loading' | 'signed-in' | 'signed-out';
  /**
   * True from `logout()` in this tab until the next login. Guards then send the visitor to
   * plain `/login`: after an explicit logout there is no page to come back to.
   */
  loggedOut: boolean;
  login: (login: string, password: string) => Promise<LoginResult>;
  /** Rejects with `LogoutFailedError` (still signed in) unless the server ended the session. */
  logout: () => Promise<void>;
}

const LOGIN_PATH = '/login';

/**
 * `location.state` of the redirect to the login page after a 401: the only navigation an
 * editor with unsaved changes lets through without asking (its draft is stored and restored).
 */
const UNAUTHORIZED_REDIRECT = { authRedirect: 'unauthorized' } as const;

export function isUnauthorizedRedirect(state: unknown): boolean {
  return (
    typeof state === 'object' &&
    state !== null &&
    'authRedirect' in state &&
    state.authRedirect === UNAUTHORIZED_REDIRECT.authRedirect
  );
}
const ME_KEY = ['auth', 'me'] as const;

/**
 * Drops every cached query of the previous session except `me` (the AuthProvider observes that
 * query; removing it would detach the observer), then sets `me`.
 */
function resetSession(queryClient: QueryClient, me: MeResponse | null) {
  queryClient.removeQueries({ predicate: (q) => q.queryKey[0] !== ME_KEY[0] });
  queryClient.setQueryData(ME_KEY, me);
}

/** `/login?next=<path>`: where to send a signed-out visitor of `path` (path + search). */
export function loginPath(next: string): string {
  return `${LOGIN_PATH}?${new URLSearchParams({ next }).toString()}`;
}

/** The signed-in user, or null: a 401 from `/me` means "signed out", not an error. */
async function fetchMe(): Promise<MeResponse | null> {
  try {
    return await api.get('/api/auth/me', MeResponse);
  } catch (e) {
    if (isApiError(e) && e.status === 401) return null;
    throw e;
  }
}

/** `logout()` did not reach a server answer of 2xx or 401: the session may still be alive. */
class LogoutFailedError extends Error {
  override readonly name = 'LogoutFailedError';
  constructor(cause: unknown) {
    super('logout failed', { cause });
  }
}

const AuthContext = createContext<Auth | null>(null);

/**
 * Session state for the whole app. Must sit inside the router: on a 401 from any API call
 * outside `/login` (the session expired) it drops the cached data and redirects to
 * `/login?next=<current path>`. On `/login` itself 401s are expected (wrong password, the
 * signed-out `/me` probe) and ignored.
 */
export function AuthProvider({ children }: { children: ReactNode }) {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const location = useLocation();
  const locationRef = useRef(location);
  useEffect(() => {
    locationRef.current = location;
  }, [location]);

  // The refs are read by the 401 subscriber (outside render); the state by the guards.
  // `loggedOutRef` stays set after a successful logout until the next login: late 401s then
  // must not redirect with ?next=, even before `locationRef` has caught up with /login.
  const loggingOutRef = useRef(false);
  const loggedOutRef = useRef(false);
  const [loggedOut, setLoggedOut] = useState(false);

  const query = useQuery({ queryKey: ME_KEY, queryFn: fetchMe, staleTime: Infinity });

  useEffect(() => {
    const unsubscribe = onUnauthorized(() => {
      const { pathname, search } = locationRef.current;
      // A logout in progress (or done) ends on plain /login: 401s racing it must not add ?next=.
      if (loggingOutRef.current || loggedOutRef.current || pathname === LOGIN_PATH) return;
      resetSession(queryClient, null);
      void navigate(loginPath(pathname + search), { replace: true, state: UNAUTHORIZED_REDIRECT });
    });
    return () => {
      unsubscribe();
    };
  }, [queryClient, navigate]);

  const me = query.data ?? null;
  const status: Auth['status'] = query.isPending ? 'loading' : me ? 'signed-in' : 'signed-out';

  const value = useMemo<Auth>(
    () => ({
      me,
      status,
      loggedOut,
      async login(login, password) {
        try {
          await api.post('/api/auth/login', { login, password });
        } catch (e) {
          if (isApiError(e) && e.status === 401) return { ok: false, reason: 'invalid' };
          if (isApiError(e) && e.status === 429) {
            return e.retryAfterSec === undefined
              ? { ok: false, reason: 'rate_limited' }
              : { ok: false, reason: 'rate_limited', retryAfterSec: e.retryAfterSec };
          }
          throw e;
        }
        // 204 but no session: the browser dropped the cookie (Secure cookie over plain http).
        const signedIn = await fetchMe();
        if (!signedIn) return { ok: false, reason: 'cookie_blocked' };
        resetSession(queryClient, signedIn);
        unfreezeDrafts();
        loggedOutRef.current = false;
        setLoggedOut(false);
        return { ok: true };
      },
      async logout() {
        // Fail closed: the client session is cleared only once the server has ended it (2xx)
        // or it had already ended (401). Until then the flag keeps racing 401s from
        // redirecting to /login?next=, and in-flight queries are cancelled.
        loggingOutRef.current = true;
        // From here on no editor writes a draft (pending saves, unmount flushes): after the
        // logout the tab may be someone else's.
        freezeDrafts();
        try {
          await queryClient.cancelQueries();
          try {
            await api.post('/api/auth/logout');
          } catch (e) {
            if (!isApiError(e) || e.status !== 401) {
              // The server session may still be valid: stay signed in, show the real state.
              await queryClient.refetchQueries({ queryKey: ME_KEY });
              throw new LogoutFailedError(e);
            }
          }
          clearAllDrafts();
          loggedOutRef.current = true;
          setLoggedOut(true);
          resetSession(queryClient, null);
          await navigate(LOGIN_PATH, { replace: true });
        } finally {
          loggingOutRef.current = false;
          if (!loggedOutRef.current) unfreezeDrafts(); // still signed in: drafts work again
        }
      },
    }),
    [me, status, loggedOut, queryClient, navigate],
  );

  return <AuthContext value={value}>{children}</AuthContext>;
}

export function useAuth(): Auth {
  const auth = use(AuthContext);
  if (!auth) throw new Error('useAuth must be used inside <AuthProvider>');
  return auth;
}
