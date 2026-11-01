import { useEffect, useRef, type MutableRefObject, type ReactNode } from 'react';
import { useBlocker } from 'react-router';
import { isUnauthorizedRedirect } from '@/auth/AuthProvider.tsx';
import { ConfirmDialog } from '@/components/ConfirmDialog.tsx';
import { useUnsavedChanges } from '@/lib/unsavedChanges.ts';
import { strings } from '@/strings.ts';

export interface LeaveGuardOptions {
  /** True while the page holds unsaved changes. */
  dirty: boolean;
  /** Set once the edit is saved or abandoned: leaving no longer needs a confirmation. */
  doneRef: MutableRefObject<boolean>;
  /** Extra condition under which a route change is let through without asking. */
  allowLeave?: () => boolean;
  /** Runs when the visitor confirms leaving. */
  onLeave?: () => void;
}

/**
 * Unsaved-changes guard of an editor page: the browser's unload prompt, the shell's "Sign out"
 * check, and a confirmation for route changes. Returns the confirmation dialog to render.
 * A 401's redirect to the login page and the logout's own redirect are let through (the shell
 * already asked for the latter).
 */
export function useLeaveGuard({
  dirty,
  doneRef,
  allowLeave,
  onLeave,
}: LeaveGuardOptions): ReactNode {
  // Read outside render (the blocker): updated after every commit.
  const dirtyRef = useRef(dirty);
  const allowLeaveRef = useRef(allowLeave);
  useEffect(() => {
    dirtyRef.current = dirty;
    allowLeaveRef.current = allowLeave;
  });

  useEffect(() => {
    if (!dirty) return undefined;
    const onBeforeUnload = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => window.removeEventListener('beforeunload', onBeforeUnload);
  }, [dirty]);

  // Lets the shell's "Sign out" ask first too (it is not a route change of this page).
  useUnsavedChanges(dirty);

  const blocker = useBlocker(
    ({ currentLocation, nextLocation }) =>
      dirtyRef.current &&
      !doneRef.current &&
      !isUnauthorizedRedirect(nextLocation.state) &&
      !(allowLeaveRef.current?.() ?? false) &&
      nextLocation.pathname !== currentLocation.pathname,
  );
  const leaveRef = useRef(false);
  const t = strings.editor;

  return (
    <ConfirmDialog
      open={blocker.state === 'blocked'}
      onOpenChange={(open) => {
        if (open || blocker.state !== 'blocked') return;
        if (leaveRef.current) blocker.proceed();
        else blocker.reset();
        leaveRef.current = false;
      }}
      title={t.leaveTitle}
      description={t.leaveDescription}
      confirmLabel={t.leaveConfirm}
      destructive
      onConfirm={() => {
        doneRef.current = true;
        leaveRef.current = true;
        onLeave?.();
      }}
    />
  );
}
