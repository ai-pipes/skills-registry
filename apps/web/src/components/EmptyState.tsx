import type { LucideIcon } from 'lucide-react';
import type { ReactNode } from 'react';
import { cn } from '@/lib/utils.ts';

export interface EmptyStateProps {
  title: string;
  description?: string;
  icon?: LucideIcon;
  /** E.g. a button that creates the first item. */
  action?: ReactNode;
  className?: string;
}

/** Centered placeholder for an empty list, a missing page or a section that is not ready. */
export function EmptyState({ title, description, icon: Icon, action, className }: EmptyStateProps) {
  return (
    <div
      className={cn(
        'flex flex-col items-center justify-center gap-2 px-4 py-16 text-center',
        className,
      )}
    >
      {Icon && <Icon aria-hidden className="size-8 text-muted-foreground" />}
      <h2 className="text-lg font-medium">{title}</h2>
      {description && <p className="max-w-md text-sm text-muted-foreground">{description}</p>}
      {action && <div className="mt-2">{action}</div>}
    </div>
  );
}
