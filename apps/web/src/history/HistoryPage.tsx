import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { notify } from '@/lib/notify.ts';
import { isApiError } from '@/api/errors.ts';
import { useHistory, useRollback } from '@/api/queries.ts';
import { ConfirmDialog } from '@/components/ConfirmDialog.tsx';
import { ErrorAlert } from '@/components/ErrorAlert.tsx';
import { Badge } from '@/components/ui/badge';
import { Button, buttonVariants } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Skeleton } from '@/components/ui/skeleton';
import { formatDateTime, formatRelative } from '@/lib/format.ts';
import { strings } from '@/strings.ts';
import { shortSha } from '@/skills/source.ts';

/** `/skills/:slug/history`: versions newest first, compare any two, roll back to one. */
export function HistoryPage() {
  const { slug = '' } = useParams();
  const navigate = useNavigate();
  const history = useHistory(slug);
  const rollback = useRollback(slug);
  const [picked, setPicked] = useState<number[]>([]);
  const [conflict, setConflict] = useState(false);
  const base = `/skills/${encodeURIComponent(slug)}`;

  if (history.isError) return <ErrorAlert error={history.error} />;
  if (history.data === undefined) {
    return (
      <Skeleton className="h-64 w-full" aria-busy="true" aria-label={strings.common.loading} />
    );
  }
  const versions = history.data;
  const current = versions.reduce((max, v) => Math.max(max, v.number), 0);

  function toggle(n: number, on: boolean) {
    setPicked((p) => (on ? [...p, n].slice(-2) : p.filter((x) => x !== n)));
  }

  function compare() {
    const [from = 0, to = 0] = picked.toSorted((a, b) => a - b);
    void navigate(`${base}/diff?from=${from}&to=${to}`);
  }

  async function doRollback(toVersion: number) {
    setConflict(false);
    try {
      await rollback.mutateAsync({ toVersion, baseVersion: current });
    } catch (e) {
      if (isApiError(e) && e.status === 409) {
        setConflict(true); // history was refetched by the mutation's onSettled
        return;
      }
      throw e;
    }
    notify.success(strings.history.rolledBack(toVersion));
  }

  return (
    <div className="mx-auto flex w-full max-w-4xl flex-col gap-4">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div className="flex flex-col gap-1">
          <Link to={base} className="text-sm text-muted-foreground underline">
            {strings.history.backToSkill}
          </Link>
          <h1 className="text-2xl font-semibold">{strings.history.title}</h1>
          <p className="font-mono text-sm text-muted-foreground">{slug}</p>
        </div>
        <Button disabled={picked.length !== 2} onClick={compare}>
          {strings.history.compare}
        </Button>
      </header>
      {conflict && <ErrorAlert message={strings.history.conflict} />}
      <ul className="flex flex-col divide-y rounded-lg border">
        {versions.map((v) => (
          <li key={v.number} className="flex flex-wrap items-start gap-3 p-3">
            <Checkbox
              aria-label={strings.history.pick(v.number)}
              checked={picked.includes(v.number)}
              onCheckedChange={(on) => toggle(v.number, on)}
              className="mt-1"
            />
            <div className="flex min-w-0 flex-1 flex-col gap-1">
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-medium">v{v.number}</span>
                {v.number === current && <Badge>{strings.history.currentBadge}</Badge>}
                {v.restoredFrom !== null && (
                  <Badge variant="secondary">{strings.history.restoredFrom(v.restoredFrom)}</Badge>
                )}
                {v.sourceCommit !== null && (
                  <Badge variant="outline">
                    {strings.history.fromGithub(shortSha(v.sourceCommit))}
                  </Badge>
                )}
                <span className="text-sm text-muted-foreground">
                  {v.authorLogin ?? strings.history.deletedUser}
                </span>
                <time
                  dateTime={v.createdAt}
                  title={formatDateTime(v.createdAt)}
                  className="text-sm text-muted-foreground"
                >
                  {formatRelative(v.createdAt)}
                </time>
              </div>
              {v.message && <p className="text-sm break-words">{v.message}</p>}
            </div>
            <div className="flex gap-2">
              <Link
                to={`${base}?version=${v.number}`}
                className={buttonVariants({ variant: 'outline', size: 'sm' })}
              >
                {strings.history.open}
              </Link>
              {v.number !== current && (
                <ConfirmDialog
                  trigger={
                    <Button variant="outline" size="sm">
                      {strings.history.rollback}
                    </Button>
                  }
                  title={strings.history.rollbackTitle(v.number)}
                  description={strings.history.rollbackDescription}
                  confirmLabel={strings.history.rollbackConfirm}
                  onConfirm={() => doRollback(v.number)}
                />
              )}
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}
