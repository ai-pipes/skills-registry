import { useState, type FormEvent } from 'react';
import { Navigate, useSearchParams } from 'react-router';
import { useAuthConfig } from '@/api/queries.ts';
import { ErrorAlert } from '@/components/ErrorAlert.tsx';
import { Button, buttonVariants } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import { strings } from '@/strings.ts';
import { useAuth, type LoginResult } from './AuthProvider.tsx';

const DEFAULT_NEXT = '/skills';

/**
 * `?next=` is honoured only for an in-app path: it must start with a single `/`. `//host`,
 * `/\host` and control characters (browsers strip tabs/newlines, turning `/\t/host` into
 * `//host`) would leave the site, so they fall back to the default.
 */
function safeNext(next: string | null): string {
  if (!next?.startsWith('/') || next.startsWith('//')) return DEFAULT_NEXT;
  // oxlint-disable-next-line no-control-regex -- control characters are exactly what we reject
  if (/[\\\u0000-\u001f\u007f]/.test(next)) return DEFAULT_NEXT;
  return next;
}

type Failure = Extract<LoginResult, { ok: false }>;

function failureText(failure: Failure): string {
  if (failure.reason === 'invalid') return strings.login.invalid;
  if (failure.reason === 'cookie_blocked') return strings.login.cookieBlocked;
  // Retry-After is in seconds; the message is in whole minutes (at least 1).
  const minutes = Math.max(1, Math.ceil((failure.retryAfterSec ?? 60) / 60));
  return strings.login.rateLimited(minutes);
}

/**
 * Single sign-on: a plain link (a top-level navigation, so CSP is unaffected) to the server's
 * login route, which redirects to the provider and comes back to `returnTo`. A failed sign-in
 * comes back as `/login?loginError=<code>`.
 */
function SsoLogin({ returnTo, errorCode }: { returnTo: string; errorCode: string | null }) {
  const href = `/api/auth/sso/login?returnTo=${encodeURIComponent(returnTo)}`;
  const { ssoErrors } = strings.login;
  return (
    <div className="flex flex-col gap-4">
      {errorCode !== null && (
        <ErrorAlert
          title={strings.login.ssoErrorTitle}
          message={Object.hasOwn(ssoErrors, errorCode) ? ssoErrors[errorCode] : ssoErrors.internal}
        />
      )}
      <p className="text-sm text-muted-foreground">{strings.login.ssoHint}</p>
      <a href={href} className={buttonVariants()}>
        {strings.login.ssoSubmit}
      </a>
    </div>
  );
}

function PasswordLogin() {
  const { login } = useAuth();
  const [form, setForm] = useState({ login: '', password: '' });
  const [submitting, setSubmitting] = useState(false);
  const [failure, setFailure] = useState<Failure | null>(null);
  const [error, setError] = useState<unknown>(null);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSubmitting(true);
    setFailure(null);
    setError(null);
    try {
      const result = await login(form.login, form.password);
      if (!result.ok) setFailure(result);
    } catch (e) {
      setError(e);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form className="flex flex-col gap-4" onSubmit={(e) => void onSubmit(e)} noValidate>
      {error !== null && <ErrorAlert error={error} />}
      <div className="flex flex-col gap-2">
        <Label htmlFor="login">{strings.login.login}</Label>
        <Input
          id="login"
          name="username"
          autoComplete="username"
          required
          maxLength={1024}
          value={form.login}
          onChange={(e) => setForm({ ...form, login: e.target.value })}
        />
      </div>
      <div className="flex flex-col gap-2">
        <Label htmlFor="password">{strings.login.password}</Label>
        <Input
          id="password"
          name="password"
          type="password"
          autoComplete="current-password"
          required
          maxLength={4096}
          aria-invalid={failure?.reason === 'invalid' || undefined}
          aria-describedby={failure ? 'login-failure' : undefined}
          value={form.password}
          onChange={(e) => setForm({ ...form, password: e.target.value })}
        />
        {failure && (
          <p id="login-failure" role="alert" className="text-sm text-destructive">
            {failureText(failure)}
          </p>
        )}
      </div>
      <Button type="submit" disabled={submitting}>
        {submitting ? strings.login.submitting : strings.login.submit}
      </Button>
    </form>
  );
}

/**
 * `/login`: the password form or, when the server signs people in through an identity provider
 * (`GET /api/auth/config`), the single sign-on link. If the config cannot be loaded, the
 * password form is shown: the server answers it either way.
 */
export function LoginPage() {
  const { status } = useAuth();
  const config = useAuthConfig();
  const [params] = useSearchParams();
  const next = safeNext(params.get('next'));

  // Signed in (already, or by the submit below): go where the visitor was heading.
  if (status === 'signed-in') return <Navigate to={next} replace />;
  if (status === 'loading') return null;

  let body;
  if (config.isPending) {
    body = (
      <Skeleton role="status" aria-label={strings.login.loadingMethod} className="h-9 w-full" />
    );
  } else if (config.data?.method === 'sso') {
    body = <SsoLogin returnTo={next} errorCode={params.get('loginError')} />;
  } else {
    body = <PasswordLogin />;
  }

  return (
    <main className="flex min-h-svh items-center justify-center p-4">
      <Card className="w-full max-w-sm">
        <CardHeader>
          <CardTitle>
            <h1 className="text-xl font-semibold">{strings.login.title}</h1>
          </CardTitle>
        </CardHeader>
        <CardContent>{body}</CardContent>
      </Card>
    </main>
  );
}
