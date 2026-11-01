import type { FolderRef } from '@skills/contracts';
import { useState } from 'react';
import { Link } from 'react-router';
import { isApiError } from '@/api/errors.ts';
import {
  useFolders,
  useRestoreFolder,
  useRestoreSkillTo,
  useRestoreSubagent,
  useSetArchived,
} from '@/api/queries.ts';
import { ErrorAlert } from '@/components/ErrorAlert.tsx';
import { Button, buttonVariants } from '@/components/ui/button';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { notify } from '@/lib/notify.ts';
import { strings } from '@/strings.ts';
import { FolderPicker } from './FolderPicker.tsx';

export interface RestoreSkillDialogProps {
  slug: string;
  /** What is restored: a skill (default) or a subagent; only the endpoint and the texts differ. */
  kind?: 'skill' | 'subagent';
  /** The skill's (archived) folder. */
  folder: FolderRef;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/** Mounted by the parent only while open, so its state starts clean. The skill's folder is archived: restore the folder with the skill, or restore into another folder. */
export function RestoreSkillDialog({
  slug,
  kind = 'skill',
  folder,
  open,
  onOpenChange,
}: RestoreSkillDialogProps) {
  const folders = useFolders('active');
  const restoreFolder = useRestoreFolder(folder.slug);
  const setSkillArchived = useSetArchived(slug);
  const restoreSkillInto = useRestoreSkillTo(slug);
  const restoreSubagent = useRestoreSubagent(slug);
  const subagent = kind === 'subagent';
  const texts = subagent ? strings.subagent : strings.skill;
  const restoreItem = () =>
    subagent ? restoreSubagent.mutateAsync(undefined) : setSkillArchived.mutateAsync(false);
  const restoreInto = (target: string) =>
    subagent ? restoreSubagent.mutateAsync(target) : restoreSkillInto.mutateAsync(target);
  const [target, setTarget] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const others = (folders.data ?? []).filter((f) => f.slug !== folder.slug);

  const chosen = others.find((f) => f.slug === target);

  async function run(action: () => Promise<unknown>) {
    setPending(true);
    setError(null);
    try {
      await action();
      notify.success(texts.restored);
      onOpenChange(false);
    } catch (e) {
      setError(e);
    } finally {
      setPending(false);
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (pending) return;
        onOpenChange(next);
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{texts.restoreFolderTitle(folder.name)}</DialogTitle>
        </DialogHeader>
        <Button
          type="button"
          disabled={pending}
          onClick={() =>
            void run(async () => {
              await restoreFolder.mutateAsync();
              await restoreItem();
            })
          }
        >
          {subagent
            ? strings.subagent.restoreFolderAndSubagent
            : strings.skill.restoreFolderAndSkill}
        </Button>
        {folders.isError && <ErrorAlert error={folders.error} />}
        {folders.data !== undefined && others.length === 0 ? (
          <div className="flex flex-col items-start gap-3">
            <p className="text-sm text-muted-foreground">{strings.skill.noOtherFolders}</p>
            <Link to="/folders/new" className={buttonVariants({ variant: 'outline' })}>
              {strings.skill.createFolder}
            </Link>
          </div>
        ) : (
          <div className="flex flex-col gap-2">
            <FolderPicker
              folders={others}
              value={target}
              onChange={setTarget}
              label={strings.skill.moveTarget}
            />
            <Button
              type="button"
              variant="outline"
              disabled={chosen === undefined || pending}
              onClick={() => void run(() => restoreInto(chosen?.slug ?? ''))}
            >
              {strings.skill.restoreInto}
            </Button>
          </div>
        )}
        {error !== null && (
          <ErrorAlert
            error={error}
            message={isApiError(error) ? texts.errors[error.code] : undefined}
          />
        )}
      </DialogContent>
    </Dialog>
  );
}
