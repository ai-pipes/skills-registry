import type { FolderRef } from '@skills/contracts';
import {
  ArchiveIcon,
  ArchiveRestoreIcon,
  FolderInputIcon,
  HistoryIcon,
  PencilIcon,
} from 'lucide-react';
import { useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router';
import { isApiError } from '@/api/errors.ts';
import { useArchiveSubagent, useFolders, useRestoreSubagent, useSubagent } from '@/api/queries.ts';
import { ConfirmDialog } from '@/components/ConfirmDialog.tsx';
import { CopyField } from '@/components/CopyField.tsx';
import { EmptyState } from '@/components/EmptyState.tsx';
import { ErrorAlert } from '@/components/ErrorAlert.tsx';
import { Badge } from '@/components/ui/badge';
import { Button, buttonVariants } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { formatDateTime, formatRelative } from '@/lib/format.ts';
import { notify } from '@/lib/notify.ts';
import { strings } from '@/strings.ts';
import { Markdown } from '@/skills/Markdown.tsx';
import { MoveSkillDialog } from '@/skills/MoveSkillDialog.tsx';
import { RestoreSkillDialog } from '@/skills/RestoreSkillDialog.tsx';

/** The YAML front matter is metadata (shown in the header), not part of the rendered prompt. */
function withoutFrontMatter(md: string): string {
  return md.replace(/^---\r?\n[\s\S]*?\r?\n---[ \t]*(\r?\n|$)/, '');
}

function parseVersion(raw: string | null): number | undefined {
  if (raw === null || !/^[1-9]\d{0,9}$/.test(raw)) return undefined;
  const n = Number(raw);
  return n <= 2_147_483_647 ? n : undefined;
}

function ArchiveButton({
  slug,
  archived,
  folder,
}: {
  slug: string;
  archived: boolean;
  folder: FolderRef;
}) {
  const archive = useArchiveSubagent(slug);
  const restore = useRestoreSubagent(slug);
  const folders = useFolders('all');
  const [choose, setChoose] = useState(false);
  const folderArchived =
    archived && folders.data?.find((f) => f.slug === folder.slug)?.status === 'archived';
  const button = (
    <Button
      variant="outline"
      disabled={archived && folders.isPending}
      onClick={folderArchived ? () => setChoose(true) : undefined}
    >
      {archived ? <ArchiveRestoreIcon aria-hidden /> : <ArchiveIcon aria-hidden />}
      {archived ? strings.subagent.restore : strings.subagent.archive}
    </Button>
  );
  return (
    <>
      {folderArchived ? (
        button
      ) : (
        <ConfirmDialog
          trigger={button}
          title={archived ? strings.subagent.restoreTitle : strings.subagent.archiveTitle}
          description={
            archived ? strings.subagent.restoreDescription : strings.subagent.archiveDescription
          }
          confirmLabel={archived ? strings.subagent.restore : strings.subagent.archive}
          destructive={!archived}
          onConfirm={async () => {
            try {
              await (archived ? restore.mutateAsync(undefined) : archive.mutateAsync());
            } catch (e) {
              // The folder was archived elsewhere: offer the choice instead of failing.
              if (archived && isApiError(e) && e.code === 'folder_archived') {
                setChoose(true);
                return;
              }
              throw e;
            }
            notify.success(archived ? strings.subagent.restored : strings.subagent.archived);
          }}
        />
      )}
      {archived && choose && (
        <RestoreSkillDialog
          kind="subagent"
          slug={slug}
          folder={folder}
          open={choose}
          onOpenChange={setChoose}
        />
      )}
    </>
  );
}

function PageSkeleton() {
  return (
    <div className="flex flex-col gap-4" aria-busy="true" aria-label={strings.common.loading}>
      <Skeleton className="h-8 w-1/3" />
      <Skeleton className="h-4 w-2/3" />
      <Skeleton className="h-64 w-full" />
    </div>
  );
}

/** `/subagents/:slug[?version=N]`: header with actions, model, tools, skills, the rendered prompt. */
export function SubagentPage() {
  const { slug = '' } = useParams();
  const [params] = useSearchParams();
  const version = parseVersion(params.get('version'));
  const subagent = useSubagent(slug, version);
  const [moving, setMoving] = useState(false);

  if (subagent.isError) {
    const code = isApiError(subagent.error) ? subagent.error.code : undefined;
    if (code === 'subagent_not_found') {
      return (
        <EmptyState title={strings.subagent.notFound} description={strings.subagent.notFoundHint} />
      );
    }
    if (code === 'version_not_found') {
      return <EmptyState title={strings.subagent.versionNotFound} />;
    }
    return <ErrorAlert error={subagent.error} />;
  }
  if (subagent.data === undefined) return <PageSkeleton />;

  const data = subagent.data;
  const archived = data.status === 'archived';
  const base = `/subagents/${encodeURIComponent(data.slug)}`;

  return (
    <div className="mx-auto flex w-full max-w-4xl flex-col gap-6">
      <header className="flex flex-col gap-3">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="flex min-w-0 flex-col gap-1">
            <div className="flex flex-wrap items-center gap-2">
              <h1 className="text-2xl font-semibold break-words">{data.name}</h1>
              {archived && <Badge variant="secondary">{strings.subagent.archivedBadge}</Badge>}
            </div>
            <p className="flex flex-wrap gap-x-3 text-sm text-muted-foreground">
              <Link
                to={`/subagents?folder=${encodeURIComponent(data.folder.slug)}${archived ? '&status=archived' : ''}`}
                className="underline-offset-2 hover:underline"
              >
                {data.folder.name}
              </Link>
              <span className="font-mono">{data.slug}</span>
              <span>{strings.subagent.version(data.version)}</span>
              <time dateTime={data.updatedAt} title={formatDateTime(data.updatedAt)}>
                {strings.subagent.updated(formatRelative(data.updatedAt))}
              </time>
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            {!archived && (
              <Link to={`${base}/edit`} className={buttonVariants({ variant: 'outline' })}>
                <PencilIcon aria-hidden />
                {strings.subagent.edit}
              </Link>
            )}
            <Link to={`${base}/history`} className={buttonVariants({ variant: 'outline' })}>
              <HistoryIcon aria-hidden />
              {strings.subagent.history}
            </Link>
            {!archived && (
              <Button variant="outline" onClick={() => setMoving(true)}>
                <FolderInputIcon aria-hidden />
                {strings.subagent.move}
              </Button>
            )}
            <ArchiveButton slug={data.slug} archived={archived} folder={data.folder} />
          </div>
        </div>
        {data.description && <p className="text-muted-foreground">{data.description}</p>}
      </header>
      {!archived && moving && (
        <MoveSkillDialog
          kind="subagent"
          slug={data.slug}
          current={data.folder}
          open={moving}
          onOpenChange={setMoving}
        />
      )}
      <dl className="grid gap-x-6 gap-y-3 text-sm sm:grid-cols-[8rem_minmax(0,1fr)]">
        <dt className="text-muted-foreground">{strings.subagent.model}</dt>
        <dd>{data.model}</dd>
        <dt className="text-muted-foreground">{strings.subagent.tools}</dt>
        <dd className="flex flex-wrap gap-1">
          {data.tools === null ? (
            <span>{strings.subagent.allTools}</span>
          ) : (
            data.tools.map((tool) => (
              <Badge key={tool} variant="secondary" className="font-mono">
                {tool}
              </Badge>
            ))
          )}
        </dd>
        {data.skills.length > 0 && (
          <>
            <dt className="text-muted-foreground">{strings.subagent.skills}</dt>
            <dd className="flex flex-wrap gap-x-3 gap-y-1">
              {data.skills.map((skill) => (
                <Link
                  key={skill}
                  to={`/skills/${encodeURIComponent(skill)}`}
                  className="underline underline-offset-2"
                >
                  {skill}
                </Link>
              ))}
            </dd>
          </>
        )}
      </dl>
      <CopyField
        label={strings.subagent.installCommand}
        value={`skills-registry subagent install ${data.slug}`}
      />
      <section aria-label={strings.subagent.prompt} className="min-w-0">
        <Markdown slug={data.slug} source={withoutFrontMatter(data.content)} />
      </section>
    </div>
  );
}
