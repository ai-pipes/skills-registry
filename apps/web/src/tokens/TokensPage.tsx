import { CreatedToken, type TokenSummary } from '@skills/contracts';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { KeyRoundIcon, PlusIcon, TriangleAlertIcon } from 'lucide-react';
import { useId, useState, type FormEvent } from 'react';
import { notify } from '@/lib/notify.ts';
import { api } from '@/api/client.ts';
import { queryKeys, useTokens } from '@/api/queries.ts';
import { ConfirmDialog } from '@/components/ConfirmDialog.tsx';
import { CopyField } from '@/components/CopyField.tsx';
import { EmptyState } from '@/components/EmptyState.tsx';
import { ErrorAlert } from '@/components/ErrorAlert.tsx';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { formatDateTime, formatRelative } from '@/lib/format.ts';
import { strings } from '@/strings.ts';

const t = strings.tokens;

/**
 * `POST /api/tokens`. The plaintext token must not sit in the shared MutationCache (it would
 * outlive the dialog), so the result goes to `onCreated` and the mutation itself holds no data;
 * `gcTime: 0` drops the finished mutation as soon as nothing observes it.
 */
function useCreateToken(onCreated: (created: CreatedToken) => void) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: async (name: string): Promise<void> => {
      onCreated(await api.post('/api/tokens', { name }, CreatedToken));
    },
    gcTime: 0,
    onSuccess: () => client.invalidateQueries({ queryKey: queryKeys.tokens }),
  });
}

function useRevokeToken() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.delete(`/api/tokens/${encodeURIComponent(id)}`),
    onSuccess: () => client.invalidateQueries({ queryKey: queryKeys.tokens }),
  });
}

function When({ iso }: { iso: string }) {
  return (
    <time dateTime={iso} title={formatDateTime(iso)}>
      {formatRelative(iso)}
    </time>
  );
}

/**
 * "Create token": a name, then the token and its connect command, shown only here and only
 * once. Closing the dialog forgets them.
 */
function CreateTokenDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const nameId = useId();
  const errorId = `${nameId}-error`;
  const [name, setName] = useState('');
  const [nameError, setNameError] = useState(false);
  // Lives only in this component: gone when the dialog closes or the page is left.
  const [created, setCreated] = useState<CreatedToken | null>(null);
  const create = useCreateToken(setCreated);

  function change(next: boolean) {
    if (create.isPending) return;
    onOpenChange(next);
    if (!next) {
      // forget the plaintext token as soon as the dialog closes
      setName('');
      setNameError(false);
      setCreated(null);
      create.reset();
    }
  }

  function submit(e: FormEvent) {
    e.preventDefault();
    if (name.trim() === '') {
      setNameError(true);
      return;
    }
    setNameError(false);
    create.mutate(name.trim());
  }

  return (
    <Dialog open={open} onOpenChange={change}>
      <DialogContent showCloseButton={false} className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>{t.createTitle}</DialogTitle>
          {!created && <DialogDescription>{t.hint}</DialogDescription>}
        </DialogHeader>
        {created ? (
          <div className="flex flex-col gap-4">
            <div role="status" className="flex gap-2 rounded-lg border border-destructive/50 p-3">
              <TriangleAlertIcon aria-hidden className="mt-0.5 size-4 shrink-0 text-destructive" />
              <div className="flex flex-col gap-1">
                <p className="font-medium">{t.shownOnce}</p>
                <p className="text-muted-foreground">{t.shownOnceHint}</p>
              </div>
            </div>
            <CopyField label={t.token} value={created.token} />
            <CopyField label={t.connectCommand} value={created.connectCommand} />
            <DialogFooter>
              <Button type="button" onClick={() => change(false)}>
                {t.done}
              </Button>
            </DialogFooter>
          </div>
        ) : (
          <form className="flex flex-col gap-4" noValidate onSubmit={submit}>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor={nameId}>{t.name}</Label>
              <Input
                id={nameId}
                value={name}
                maxLength={100}
                placeholder={t.namePlaceholder}
                aria-invalid={nameError || undefined}
                aria-describedby={nameError ? errorId : undefined}
                onChange={(e) => setName(e.target.value)}
              />
              {nameError && (
                <p id={errorId} className="text-sm text-destructive">
                  {t.nameRequired}
                </p>
              )}
            </div>
            {create.isError && <ErrorAlert error={create.error} />}
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
                {create.isPending ? t.submitting : t.submit}
              </Button>
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}

function TokenRow({ token }: { token: TokenSummary }) {
  const revoke = useRevokeToken();
  const revoked = token.revokedAt !== null;
  return (
    <TableRow>
      <TableCell className="font-medium">{token.name}</TableCell>
      <TableCell className="font-mono text-xs">{`${token.prefix}…`}</TableCell>
      <TableCell>
        <When iso={token.createdAt} />
      </TableCell>
      <TableCell>
        {token.lastUsedAt === null ? (
          <span className="text-muted-foreground">{t.never}</span>
        ) : (
          <When iso={token.lastUsedAt} />
        )}
      </TableCell>
      <TableCell>
        <Badge variant={revoked ? 'secondary' : 'outline'}>{revoked ? t.revoked : t.active}</Badge>
      </TableCell>
      <TableCell className="text-right">
        {!revoked && (
          <ConfirmDialog
            trigger={
              <Button variant="outline" size="sm">
                {t.revoke}
              </Button>
            }
            title={t.revokeTitle}
            description={t.revokeDescription(token.name)}
            confirmLabel={t.revoke}
            destructive
            onConfirm={async () => {
              await revoke.mutateAsync(token.id);
              notify.success(t.revokedToast);
            }}
          />
        )}
      </TableCell>
    </TableRow>
  );
}

/** `/tokens`: the signed-in user's API tokens. */
export function TokensPage() {
  const tokens = useTokens();
  const [open, setOpen] = useState(false);
  const createButton = (
    <Button onClick={() => setOpen(true)}>
      <PlusIcon aria-hidden />
      {t.create}
    </Button>
  );

  let body;
  if (tokens.isError) body = <ErrorAlert error={tokens.error} />;
  else if (tokens.data === undefined) body = <Skeleton className="h-32 w-full" />;
  else if (tokens.data.length === 0) {
    body = <EmptyState icon={KeyRoundIcon} title={t.empty} description={t.emptyHint} />;
  } else {
    body = (
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>{t.columns.name}</TableHead>
            <TableHead>{t.columns.prefix}</TableHead>
            <TableHead>{t.columns.createdAt}</TableHead>
            <TableHead>{t.columns.lastUsedAt}</TableHead>
            <TableHead>{t.columns.status}</TableHead>
            <TableHead className="text-right">
              <span className="sr-only">{t.columns.actions}</span>
            </TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {tokens.data.map((token) => (
            <TokenRow key={token.id} token={token} />
          ))}
        </TableBody>
      </Table>
    );
  }

  return (
    <div className="mx-auto flex w-full max-w-4xl flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h1 className="text-2xl font-semibold">{t.title}</h1>
        {createButton}
      </div>
      <p className="text-sm text-muted-foreground">{t.hint}</p>
      {body}
      <CreateTokenDialog open={open} onOpenChange={setOpen} />
    </div>
  );
}
