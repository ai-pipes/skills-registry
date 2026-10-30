import type { Role, UserSummary } from '@skills/contracts';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { UserPlusIcon } from 'lucide-react';
import { useId, useState, type ComponentProps, type FormEvent } from 'react';
import { notify } from '@/lib/notify.ts';
import { api } from '@/api/client.ts';
import { isApiError } from '@/api/errors.ts';
import { queryKeys, useUsers } from '@/api/queries.ts';
import { useAuth } from '@/auth/AuthProvider.tsx';
import { ConfirmDialog } from '@/components/ConfirmDialog.tsx';
import { ErrorAlert } from '@/components/ErrorAlert.tsx';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { formatDateTime } from '@/lib/format.ts';
import { strings } from '@/strings.ts';

const t = strings.users;

/** The server's `MIN_PASSWORD_LENGTH`; checked here so a short password never leaves the form. */
const MIN_PASSWORD_LENGTH = 12;

const ROLES: Role[] = ['member', 'admin'];
const roleItems = ROLES.map((value) => ({ value, label: t.roles[value] }));

function useInvalidateUsers() {
  const client = useQueryClient();
  return () => client.invalidateQueries({ queryKey: queryKeys.users });
}

const userPath = (id: string) => `/api/users/${encodeURIComponent(id)}`;

/** A labelled input with its error under it. */
function Field({
  label,
  error,
  ...input
}: { label: string; error: string | null } & ComponentProps<typeof Input>) {
  const id = useId();
  const errorId = `${id}-error`;
  return (
    <div className="flex flex-col gap-1.5">
      <Label htmlFor={id}>{label}</Label>
      <Input
        id={id}
        aria-invalid={error !== null || undefined}
        aria-describedby={error === null ? undefined : errorId}
        {...input}
      />
      {error !== null && (
        <p id={errorId} className="text-sm text-destructive">
          {error}
        </p>
      )}
    </div>
  );
}

function AddUserDialog() {
  const roleLabelId = useId();
  const invalidate = useInvalidateUsers();
  const [open, setOpen] = useState(false);
  const [login, setLogin] = useState('');
  const [password, setPassword] = useState('');
  const [role, setRole] = useState<Role>('member');
  const [loginError, setLoginError] = useState<string | null>(null);
  const [passwordError, setPasswordError] = useState<string | null>(null);
  const create = useMutation({
    mutationFn: () => api.post('/api/users', { login: login.trim(), password, role }),
    onSuccess: invalidate,
  });

  function change(next: boolean) {
    if (create.isPending) return;
    setOpen(next);
    if (!next) {
      setLogin('');
      setPassword('');
      setRole('member');
      setLoginError(null);
      setPasswordError(null);
      create.reset();
    }
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    const badLogin = login.trim() === '' ? t.loginRequired : null;
    const badPassword = password.length < MIN_PASSWORD_LENGTH ? t.passwordTooShort : null;
    setLoginError(badLogin);
    setPasswordError(badPassword);
    if (badLogin !== null || badPassword !== null) return;
    try {
      await create.mutateAsync();
      notify.success(t.created);
      change(false);
    } catch (error) {
      if (isApiError(error) && error.code === 'user_exists') setLoginError(t.loginTaken);
      if (isApiError(error) && error.code === 'weak_password') setPasswordError(t.passwordTooShort);
    }
  }

  const fieldError =
    create.isError &&
    isApiError(create.error) &&
    (create.error.code === 'user_exists' || create.error.code === 'weak_password');

  return (
    <Dialog open={open} onOpenChange={change}>
      <Button onClick={() => change(true)}>
        <UserPlusIcon aria-hidden />
        {t.add}
      </Button>
      <DialogContent showCloseButton={false}>
        <DialogHeader>
          <DialogTitle>{t.addTitle}</DialogTitle>
        </DialogHeader>
        <form className="flex flex-col gap-4" noValidate onSubmit={(e) => void submit(e)}>
          <Field
            label={t.login}
            error={loginError}
            value={login}
            maxLength={128}
            autoComplete="off"
            onChange={(e) => setLogin(e.target.value)}
          />
          <Field
            label={t.password}
            error={passwordError}
            type="password"
            value={password}
            maxLength={1024}
            autoComplete="new-password"
            onChange={(e) => setPassword(e.target.value)}
          />
          <div className="flex flex-col gap-1.5">
            <Label id={roleLabelId}>{t.role}</Label>
            <Select
              items={roleItems}
              value={role}
              onValueChange={(v) => {
                if (v === 'admin' || v === 'member') setRole(v);
              }}
            >
              <SelectTrigger aria-labelledby={roleLabelId} className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {roleItems.map((item) => (
                  <SelectItem key={item.value} value={item.value}>
                    {item.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          {create.isError && !fieldError && <ErrorAlert error={create.error} />}
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              disabled={create.isPending}
              onClick={() => change(false)}
            >
              {strings.confirm.cancel}
            </Button>
            <Button type="submit" disabled={create.isPending}>
              {create.isPending ? t.saving : t.submit}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function ResetPasswordDialog({ user }: { user: UserSummary }) {
  const [open, setOpen] = useState(false);
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const reset = useMutation({
    mutationFn: () => api.post(`${userPath(user.id)}/password`, { password }),
  });

  function change(next: boolean) {
    if (reset.isPending) return;
    setOpen(next);
    if (!next) {
      setPassword('');
      setError(null);
      reset.reset();
    }
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (password.length < MIN_PASSWORD_LENGTH) {
      setError(t.passwordTooShort);
      return;
    }
    setError(null);
    try {
      await reset.mutateAsync();
      notify.success(t.passwordReset);
      change(false);
    } catch (err) {
      if (isApiError(err) && err.code === 'weak_password') setError(t.passwordTooShort);
    }
  }

  return (
    <Dialog open={open} onOpenChange={change}>
      <Button variant="outline" size="sm" onClick={() => change(true)}>
        {t.resetPassword}
      </Button>
      <DialogContent showCloseButton={false}>
        <DialogHeader>
          <DialogTitle>{t.resetTitle(user.login)}</DialogTitle>
        </DialogHeader>
        <form className="flex flex-col gap-4" noValidate onSubmit={(e) => void submit(e)}>
          <Field
            label={t.password}
            error={error}
            type="password"
            value={password}
            maxLength={1024}
            autoComplete="new-password"
            onChange={(e) => setPassword(e.target.value)}
          />
          {reset.isError && error === null && <ErrorAlert error={reset.error} />}
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              disabled={reset.isPending}
              onClick={() => change(false)}
            >
              {strings.confirm.cancel}
            </Button>
            <Button type="submit" disabled={reset.isPending}>
              {reset.isPending ? t.saving : t.save}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function ToggleDisabled({ user, self }: { user: UserSummary; self: boolean }) {
  const hintId = useId();
  const invalidate = useInvalidateUsers();
  const toggle = useMutation({
    mutationFn: (disabled: boolean) => api.post(`${userPath(user.id)}/disable`, { disabled }),
    onSuccess: invalidate,
  });

  if (self) {
    // A disabled button gets no pointer events, so the tooltip hangs on a wrapper.
    return (
      <>
        <Tooltip>
          <TooltipTrigger render={<span tabIndex={0} className="inline-flex" />}>
            <Button variant="outline" size="sm" disabled aria-describedby={hintId}>
              {t.disable}
            </Button>
          </TooltipTrigger>
          <TooltipContent>{t.cannotDisableSelf}</TooltipContent>
        </Tooltip>
        <span id={hintId} className="sr-only">
          {t.cannotDisableSelf}
        </span>
      </>
    );
  }

  const disable = !user.disabled;
  return (
    <ConfirmDialog
      trigger={
        <Button variant="outline" size="sm">
          {disable ? t.disable : t.enable}
        </Button>
      }
      title={disable ? t.disableTitle(user.login) : t.enableTitle(user.login)}
      description={disable ? t.disableDescription : t.enableDescription}
      confirmLabel={disable ? t.disable : t.enable}
      destructive={disable}
      onConfirm={async () => {
        await toggle.mutateAsync(disable);
        notify.success(disable ? t.disabledToast : t.enabledToast);
      }}
    />
  );
}

/** `/users` (admins only): accounts, roles, password resets and disabling. */
export function UsersPage() {
  const users = useUsers();
  const { me } = useAuth();

  let body;
  if (users.isError) body = <ErrorAlert error={users.error} />;
  else if (users.data === undefined) body = <Skeleton className="h-32 w-full" />;
  else {
    body = (
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>{t.columns.login}</TableHead>
            <TableHead>{t.columns.role}</TableHead>
            <TableHead>{t.columns.status}</TableHead>
            <TableHead>{t.columns.createdAt}</TableHead>
            <TableHead className="text-right">
              <span className="sr-only">{t.columns.actions}</span>
            </TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {users.data.map((user) => {
            const self = user.login === me?.login;
            return (
              <TableRow key={user.id}>
                <TableCell className="font-medium">
                  <span>{user.login}</span>
                  {self && <span className="ml-2 text-muted-foreground">({t.you})</span>}
                </TableCell>
                <TableCell>{t.roles[user.role]}</TableCell>
                <TableCell>
                  <Badge variant={user.disabled ? 'secondary' : 'outline'}>
                    {user.disabled ? t.disabledBadge : t.active}
                  </Badge>
                </TableCell>
                <TableCell>
                  <time dateTime={user.createdAt}>{formatDateTime(user.createdAt)}</time>
                </TableCell>
                <TableCell>
                  <div className="flex justify-end gap-2">
                    <ResetPasswordDialog user={user} />
                    <ToggleDisabled user={user} self={self} />
                  </div>
                </TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
    );
  }

  return (
    <div className="mx-auto flex w-full max-w-4xl flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h1 className="text-2xl font-semibold">{t.title}</h1>
        <AddUserDialog />
      </div>
      {body}
    </div>
  );
}
