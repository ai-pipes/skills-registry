import { useEffect, useId, useSyncExternalStore } from 'react';

// Pages with unsaved edits, by component id. Route changes are guarded by each page's own
// `useBlocker`; this registry lets actions outside the page (the shell's "Sign out") ask first.
const dirty = new Set<string>();
const listeners = new Set<() => void>();

function emit() {
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Marks the calling component as holding unsaved changes while `unsaved` is true. */
export function useUnsavedChanges(unsaved: boolean): void {
  const id = useId();
  useEffect(() => {
    if (!unsaved) return undefined;
    dirty.add(id);
    emit();
    return () => {
      dirty.delete(id);
      emit();
    };
  }, [id, unsaved]);
}

/** True while any mounted component has unsaved changes. */
export function useHasUnsavedChanges(): boolean {
  return useSyncExternalStore(
    subscribe,
    () => dirty.size > 0,
    () => false,
  );
}
