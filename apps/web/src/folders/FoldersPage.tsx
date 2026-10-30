import { FolderStatus, type FolderSummary } from '@skills/contracts';
import { FolderIcon, PlusIcon } from 'lucide-react';
import { Link, useSearchParams } from 'react-router';
import { useArchiveFolder, useFolders, useRestoreFolder } from '@/api/queries.ts';
import { ConfirmDialog } from '@/components/ConfirmDialog.tsx';
import { EmptyState } from '@/components/EmptyState.tsx';
import { ErrorAlert } from '@/components/ErrorAlert.tsx';
import { Button, buttonVariants } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { notify } from '@/lib/notify.ts';
import { strings } from '@/strings.ts';

const t = strings.folders;

const STATUSES = FolderStatus.options;

function FolderRow({ folder }: { folder: FolderSummary }) {
  const archive = useArchiveFolder(folder.slug);
  const restore = useRestoreFolder(folder.slug);
  const archived = folder.status === 'archived';
  const slug = encodeURIComponent(folder.slug);
  const skillsLink = archived ? `/skills?folder=${slug}&status=archived` : `/skills?folder=${slug}`;
  return (
    <TableRow>
      <TableCell className="font-medium">
        <Link to={skillsLink} className="hover:underline">
          {folder.name}
        </Link>
      </TableCell>
      <TableCell className="font-mono text-xs">{folder.slug}</TableCell>
      <TableCell className="max-w-xs whitespace-normal text-muted-foreground">
        {folder.description}
      </TableCell>
      <TableCell>{archived ? folder.skills.archived : folder.skills.active}</TableCell>
      <TableCell className="text-right">
        <div className="flex justify-end gap-2">
          <Link
            to={`/folders/${slug}/edit`}
            className={buttonVariants({ variant: 'outline', size: 'sm' })}
          >
            {t.edit}
          </Link>
          {archived ? (
            <ConfirmDialog
              trigger={
                <Button variant="outline" size="sm">
                  {t.restore}
                </Button>
              }
              title={t.restoreTitle(folder.name)}
              description={t.restoreDescription}
              confirmLabel={t.restore}
              onConfirm={async () => {
                await restore.mutateAsync();
                notify.success(t.restoredToast);
              }}
            />
          ) : (
            <ConfirmDialog
              trigger={
                <Button variant="outline" size="sm">
                  {t.archive}
                </Button>
              }
              title={t.archiveTitle(folder.name)}
              description={t.archiveDescription(folder.skills.active)}
              confirmLabel={t.archive}
              destructive
              onConfirm={async () => {
                await archive.mutateAsync();
                notify.success(t.archivedToast(folder.name));
              }}
            />
          )}
        </div>
      </TableCell>
    </TableRow>
  );
}

/** `/folders`: folders of one status (`?status=archived` for the archive). */
export function FoldersPage() {
  const [params, setParams] = useSearchParams();
  const parsed = FolderStatus.safeParse(params.get('status'));
  const status = parsed.success ? parsed.data : 'active';
  const folders = useFolders(status);

  function onStatus(value: unknown) {
    const next = FolderStatus.safeParse(value);
    if (!next.success) return;
    setParams(
      (prev) => {
        const copy = new URLSearchParams(prev);
        if (next.data === 'active') copy.delete('status');
        else copy.set('status', next.data);
        return copy;
      },
      { replace: true },
    );
  }

  let body;
  if (folders.isError) body = <ErrorAlert error={folders.error} />;
  else if (folders.data === undefined) body = <Skeleton className="h-32 w-full" />;
  else if (folders.data.length === 0) {
    body =
      status === 'active' ? (
        <EmptyState
          icon={FolderIcon}
          title={t.emptyActive}
          description={t.emptyActiveHint}
          action={
            <Link to="/folders/new" className={buttonVariants()}>
              {t.create}
            </Link>
          }
        />
      ) : (
        <EmptyState icon={FolderIcon} title={t.emptyArchived} />
      );
  } else {
    body = (
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>{t.columns.name}</TableHead>
            <TableHead>{t.columns.slug}</TableHead>
            <TableHead>{t.columns.description}</TableHead>
            <TableHead>{t.columns.skills}</TableHead>
            <TableHead className="text-right">
              <span className="sr-only">{t.columns.actions}</span>
            </TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {folders.data.map((folder) => (
            <FolderRow key={folder.slug} folder={folder} />
          ))}
        </TableBody>
      </Table>
    );
  }

  return (
    <div className="mx-auto flex w-full max-w-5xl flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h1 className="text-2xl font-semibold">{t.title}</h1>
        <Link to="/folders/new" className={buttonVariants()}>
          <PlusIcon aria-hidden />
          {t.create}
        </Link>
      </div>
      <p className="text-sm text-muted-foreground">{t.hint}</p>
      <Tabs value={status} onValueChange={onStatus}>
        <TabsList aria-label={t.filter}>
          {STATUSES.map((s) => (
            <TabsTrigger key={s} value={s}>
              {t.status[s]}
            </TabsTrigger>
          ))}
        </TabsList>
      </Tabs>
      {body}
    </div>
  );
}
