import type { FolderRef } from '@skills/contracts';
import { ArchiveIcon, ArchiveRestoreIcon } from 'lucide-react';
import { useState } from 'react';
import { isApiError } from '@/api/errors.ts';
import {
  useArchiveSubagent,
  useFolders,
  useRestoreSubagent,
  useSetArchived,
} from '@/api/queries.ts';
import { ConfirmDialog } from '@/components/ConfirmDialog.tsx';
import { Button } from '@/components/ui/button';
import { notify } from '@/lib/notify.ts';
import { strings } from '@/strings.ts';
import { RestoreSkillDialog } from './RestoreSkillDialog.tsx';

export interface ArchiveButtonProps {
  slug: string;
  /** What is archived: a skill (default) or a subagent; only the endpoints and the texts differ. */
  kind?: 'skill' | 'subagent';
  archived: boolean;
  folder: FolderRef;
}

/** Archive (with confirmation) or restore; restoring into an archived folder opens the choice dialog. */
export function ArchiveButton({ slug, kind = 'skill', archived, folder }: ArchiveButtonProps) {
  const setArchived = useSetArchived(slug);
  const archiveSubagent = useArchiveSubagent(slug);
  const restoreSubagent = useRestoreSubagent(slug);
  const texts = kind === 'subagent' ? strings.subagent : strings.skill;
  const run = (restore: boolean) =>
    kind === 'subagent'
      ? restore
        ? restoreSubagent.mutateAsync(undefined)
        : archiveSubagent.mutateAsync()
      : setArchived.mutateAsync(!restore);
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
      {archived ? texts.restore : texts.archive}
    </Button>
  );
  return (
    <>
      {folderArchived ? (
        button
      ) : (
        <ConfirmDialog
          trigger={button}
          title={archived ? texts.restoreTitle : texts.archiveTitle}
          description={archived ? texts.restoreDescription : texts.archiveDescription}
          confirmLabel={archived ? texts.restore : texts.archive}
          destructive={!archived}
          onConfirm={async () => {
            try {
              await run(archived);
            } catch (e) {
              // The folder was archived elsewhere: offer the choice instead of failing.
              if (archived && isApiError(e) && e.code === 'folder_archived') {
                setChoose(true);
                return;
              }
              throw e;
            }
            notify.success(archived ? texts.restored : texts.archived);
          }}
        />
      )}
      {archived && choose && (
        <RestoreSkillDialog
          kind={kind}
          slug={slug}
          folder={folder}
          open={choose}
          onOpenChange={setChoose}
        />
      )}
    </>
  );
}
