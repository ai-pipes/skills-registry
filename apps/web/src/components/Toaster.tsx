import { Toast } from '@base-ui/react/toast';
import { CircleCheckIcon, OctagonXIcon } from 'lucide-react';
import { toastManager } from '@/lib/notify.ts';
import { cn } from '@/lib/utils.ts';
import { strings } from '@/strings.ts';

/**
 * Toasts on Base UI Toast (ADR 0006): plain elements styled by Tailwind classes, no <style>
 * element, so the strict CSP needs no exception. Bottom right, card-like, newest at the bottom.
 */
export function Toaster() {
  return (
    <Toast.Provider toastManager={toastManager}>
      <Toast.Portal>
        <Toast.Viewport
          aria-label={strings.common.notifications}
          className="fixed right-4 bottom-4 z-50 flex w-[22rem] max-w-[calc(100vw-2rem)] flex-col gap-2 outline-none"
        >
          <ToastList />
        </Toast.Viewport>
      </Toast.Portal>
    </Toast.Provider>
  );
}

function ToastList() {
  const { toasts } = Toast.useToastManager();
  return toasts.map((toast) => (
    <Toast.Root
      key={toast.id}
      toast={toast}
      // Base UI's default `dialog`/`alertdialog` would read as one more open dialog (and match
      // dialog queries); the viewport's live region (and, for errors, Base UI's role="alert"
      // copy) announces the toast. `aria-modal` is meaningless on a group, so it is dropped.
      role="group"
      aria-modal={undefined}
      swipeDirection={['right', 'down']}
      className={cn(
        'flex items-center gap-2 rounded-lg border bg-popover p-4 text-sm text-popover-foreground shadow-lg',
        'transition-[opacity,translate] duration-200',
        'data-[starting-style]:translate-y-2 data-[starting-style]:opacity-0',
        'data-[ending-style]:opacity-0 data-[limited]:hidden',
        'data-[type=error]:border-destructive/50',
      )}
    >
      {toast.type === 'error' ? (
        <OctagonXIcon aria-hidden className="size-4 shrink-0 text-destructive" />
      ) : (
        <CircleCheckIcon aria-hidden className="size-4 shrink-0" />
      )}
      <Toast.Content className="min-w-0">
        <Toast.Title className="font-medium" />
      </Toast.Content>
    </Toast.Root>
  ));
}
