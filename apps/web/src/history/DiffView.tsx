import type { FileDiff } from '@skills/contracts';
import { Link, useParams, useSearchParams } from 'react-router';
import { useDiff } from '@/api/queries.ts';
import { EmptyState } from '@/components/EmptyState.tsx';
import { ErrorAlert } from '@/components/ErrorAlert.tsx';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { cn } from '@/lib/utils.ts';
import { strings } from '@/strings.ts';
import { parsePatch, type PatchLine } from './parsePatch.ts';

const MARK: Record<PatchLine['kind'], string> = { add: '+', del: '-', ctx: ' ' };
const ROW: Record<PatchLine['kind'], string> = {
  add: 'bg-green-500/15',
  del: 'bg-red-500/15',
  ctx: '',
};

/** Lines are plain text nodes: skill content is untrusted. */
function Patch({ patch }: { patch: string }) {
  const { hunks } = parsePatch(patch);
  return (
    <div className="overflow-x-auto font-mono text-xs">
      {hunks.map((hunk, i) => (
        <div key={i}>
          <div className="bg-muted px-2 py-1 text-muted-foreground">{hunk.header}</div>
          {hunk.lines.map((l, j) => (
            <div key={j} className={cn('flex whitespace-pre', ROW[l.kind])}>
              <span className="w-10 shrink-0 px-1 text-right text-muted-foreground select-none">
                {l.oldNo}
              </span>
              <span className="w-10 shrink-0 px-1 text-right text-muted-foreground select-none">
                {l.newNo}
              </span>
              <span className="w-4 shrink-0 text-center select-none">{MARK[l.kind]}</span>
              <span>{l.text}</span>
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}

function FileBody({ diff }: { diff: FileDiff }) {
  if (diff.tooLarge) {
    return <p className="p-3 text-sm text-muted-foreground">{strings.history.tooLarge}</p>;
  }
  if (diff.patch === null) {
    return <p className="p-3 text-sm text-muted-foreground">{strings.history.binaryChanged}</p>;
  }
  return <Patch patch={diff.patch} />;
}

/** Per-file diff: status badge and patch; unchanged files collapse into one line. */
function DiffView({ diffs }: { diffs: FileDiff[] }) {
  const changed = diffs.filter((d) => d.status !== 'unchanged');
  const unchanged = diffs.length - changed.length;
  return (
    <div className="flex flex-col gap-4">
      {changed.map((d) => (
        <section key={d.path} aria-label={d.path} className="overflow-hidden rounded-lg border">
          <header className="flex items-center justify-between gap-2 border-b px-3 py-2">
            <h2 className="truncate font-mono text-sm font-medium">{d.path}</h2>
            <Badge variant={d.status === 'removed' ? 'destructive' : 'secondary'}>
              {strings.history.status[d.status]}
            </Badge>
          </header>
          <FileBody diff={d} />
        </section>
      ))}
      {unchanged > 0 && (
        <p className="text-sm text-muted-foreground">{strings.history.unchangedFiles(unchanged)}</p>
      )}
    </div>
  );
}

function parseNo(raw: string | null): number | undefined {
  return raw !== null && /^[1-9]\d{0,9}$/.test(raw) ? Number(raw) : undefined;
}

/** `/skills/:slug/diff?from=&to=`. */
export function DiffPage() {
  const { slug = '' } = useParams();
  const [params] = useSearchParams();
  const from = parseNo(params.get('from'));
  const to = parseNo(params.get('to'));
  const range = from !== undefined && to !== undefined ? { from, to } : undefined;
  const diff = useDiff(slug, range?.from ?? 0, range?.to ?? 0, range !== undefined);
  const base = `/skills/${encodeURIComponent(slug)}`;

  return (
    <div className="mx-auto flex w-full max-w-5xl flex-col gap-4">
      <header className="flex flex-col gap-1">
        <Link to={`${base}/history`} className="text-sm text-muted-foreground underline">
          {strings.history.backToHistory}
        </Link>
        <h1 className="text-2xl font-semibold">
          {range ? strings.history.diffTitle(range.from, range.to) : strings.history.compare}
        </h1>
        <p className="font-mono text-sm text-muted-foreground">{slug}</p>
      </header>
      {!range ? (
        <EmptyState title={strings.history.badRange} />
      ) : diff.isError ? (
        <ErrorAlert error={diff.error} />
      ) : diff.data === undefined ? (
        <Skeleton className="h-40 w-full" aria-busy="true" aria-label={strings.common.loading} />
      ) : (
        <DiffView diffs={diff.data} />
      )}
    </div>
  );
}
