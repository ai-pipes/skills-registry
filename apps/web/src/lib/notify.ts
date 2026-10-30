import { Toast } from '@base-ui/react/toast';

/**
 * The app's one toast manager. Module-level, so any code (event handlers, mutation callbacks)
 * can show a toast; `<Toaster />` subscribes to it and renders the toasts.
 */
export const toastManager = Toast.createToastManager();

export type ToastKind = 'success' | 'error';

// `high` makes Base UI announce the toast assertively (an extra visually hidden role="alert").
const show = (type: ToastKind, title: string) => {
  toastManager.add({ type, title, priority: type === 'error' ? 'high' : 'low' });
};

/** Success goes into a toast (form errors go under the field, page errors into ErrorAlert). */
export const notify = {
  success: (text: string): void => show('success', text),
  error: (text: string): void => show('error', text),
  /** Closes every toast that is open. */
  dismissAll: (): void => toastManager.close(),
};
