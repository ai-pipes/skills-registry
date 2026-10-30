import { useState, type ReactElement, type ReactNode } from 'react';
import { ErrorAlert } from '@/components/ErrorAlert.tsx';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from '@/components/ui/alert-dialog';
import { strings } from '@/strings.ts';

export interface ConfirmDialogProps {
  /**
   * The element that opens the dialog, e.g. `<Button variant="outline">Archive</Button>`.
   * Omit it for a dialog opened by code (with `open`/`onOpenChange`).
   */
  trigger?: ReactElement;
  title: string;
  description?: ReactNode;
  /** Text of the confirming button. */
  confirmLabel: string;
  /** Red confirming button (irreversible or disruptive actions). */
  destructive?: boolean;
  /**
   * Runs on confirmation. The dialog stays open (button disabled) until it settles: closes when
   * it resolves, shows the error inside the dialog when it rejects.
   */
  onConfirm: () => Promise<unknown> | void;
  /** Controlled open state (e.g. a route blocker); uncontrolled when omitted. */
  open?: boolean;
  /** Called on every open/close, including the close after a successful confirmation. */
  onOpenChange?: (open: boolean) => void;
}

/** "Are you sure?" on top of the shadcn `alert-dialog`; shared by every confirm-first action. */
export function ConfirmDialog({
  trigger,
  title,
  description,
  confirmLabel,
  destructive = false,
  onConfirm,
  open: controlledOpen,
  onOpenChange: notifyOpenChange,
}: ConfirmDialogProps) {
  const [uncontrolledOpen, setUncontrolledOpen] = useState(false);
  const open = controlledOpen ?? uncontrolledOpen;
  function setOpen(next: boolean) {
    setUncontrolledOpen(next);
    notifyOpenChange?.(next);
  }
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<unknown>(null);

  function onOpenChange(next: boolean) {
    if (pending) return; // no closing mid-request
    setOpen(next);
    if (next) setError(null);
  }

  async function confirm() {
    setPending(true);
    setError(null);
    try {
      await onConfirm();
      setOpen(false);
    } catch (e) {
      setError(e);
    } finally {
      setPending(false);
    }
  }

  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      {trigger && <AlertDialogTrigger render={trigger} />}
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{title}</AlertDialogTitle>
          {description && <AlertDialogDescription>{description}</AlertDialogDescription>}
        </AlertDialogHeader>
        {error !== null && <ErrorAlert error={error} />}
        <AlertDialogFooter>
          <AlertDialogCancel disabled={pending}>{strings.confirm.cancel}</AlertDialogCancel>
          <AlertDialogAction
            variant={destructive ? 'destructive' : 'default'}
            disabled={pending}
            onClick={() => void confirm()}
          >
            {confirmLabel}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
