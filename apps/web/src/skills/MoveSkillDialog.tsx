import type { FolderRef } from '@skills/contracts';
import { useState } from 'react';
import { Link } from 'react-router';
import { isApiError } from '@/api/errors.ts';
import { useFolders, useMoveSkill } from '@/api/queries.ts';
import { ErrorAlert } from '@/components/ErrorAlert.tsx';
import { Button, buttonVariants } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { notify } from '@/lib/notify.ts';
import { strings } from '@/strings.ts';
import { FolderPicker } from './FolderPicker.tsx';

export interface MoveSkillDialogProps {
  slug: string;
  current: FolderRef;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/** Moves an active skill to another active folder. */
export function MoveSkillDialog({ slug, current, open, onOpenChange }: MoveSkillDialogProps) {
  const folders = useFolders('active');
  const move = useMoveSkill(slug);
  const [target, setTarget] = useState('');
  const others = (folders.data ?? []).filter((f) => f.slug !== current.slug);

  const chosen = others.find((f) => f.slug === target);

  function submit() {
    if (chosen === undefined) return;
    move.mutate(chosen.slug, {
      onSuccess: () => {
        notify.success(strings.skill.moved(chosen.name));
        onOpenChange(false);
      },
    });
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (move.isPending) return;
        onOpenChange(next);
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{strings.skill.moveTitle}</DialogTitle>
        </DialogHeader>
        {folders.isError && <ErrorAlert error={folders.error} />}
        {folders.data !== undefined && others.length === 0 ? (
          <div className="flex flex-col items-start gap-3">
            <p className="text-sm text-muted-foreground">{strings.skill.noOtherFolders}</p>
            <Link to="/folders/new" className={buttonVariants({ variant: 'outline' })}>
              {strings.skill.createFolder}
            </Link>
          </div>
        ) : (
          <FolderPicker
            folders={others}
            value={target}
            onChange={setTarget}
            label={strings.skill.moveTarget}
          />
        )}
        {move.isError && (
          <ErrorAlert
            error={move.error}
            message={isApiError(move.error) ? strings.skill.errors[move.error.code] : undefined}
          />
        )}
        <DialogFooter>
          <Button type="button" disabled={chosen === undefined || move.isPending} onClick={submit}>
            {strings.skill.move}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
