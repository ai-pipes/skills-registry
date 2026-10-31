import { Skeleton } from '@/components/ui/skeleton';
import { strings } from '@/strings.ts';

/** Placeholder of a detail page (header and body) while it loads. */
export function PageSkeleton() {
  return (
    <div className="flex flex-col gap-4" aria-busy="true" aria-label={strings.common.loading}>
      <Skeleton className="h-8 w-1/3" />
      <Skeleton className="h-4 w-2/3" />
      <Skeleton className="h-64 w-full" />
    </div>
  );
}
