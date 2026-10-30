import type { SkillView } from '@skills/contracts';
import { DownloadIcon } from 'lucide-react';
import { fileUrl, MAX_INLINE_FILE_BYTES, useSkillFile } from '@/api/queries.ts';
import { ErrorAlert } from '@/components/ErrorAlert.tsx';
import { buttonVariants } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { formatBytes } from '@/lib/format.ts';
import { strings } from '@/strings.ts';

export interface FileViewProps {
  slug: string;
  file: SkillView['files'][number];
  /** The version being viewed; omitted for the current one. */
  version?: number | undefined;
}

/**
 * One skill file: text in a monospace block; a binary file or one over 1 MiB is not fetched,
 * only its size and a "Download" link are shown.
 */
export function FileView({ slug, file, version }: FileViewProps) {
  const inline = !file.binary && file.size <= MAX_INLINE_FILE_BYTES;
  const content = useSkillFile(slug, file.path, version, inline);
  const href = fileUrl(slug, file.path, version);

  return (
    <section aria-label={file.path} className="flex min-w-0 flex-col gap-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="truncate font-mono text-sm font-medium">{file.path}</h2>
        <span className="text-xs text-muted-foreground">{formatBytes(file.size)}</span>
      </div>
      {!inline ? (
        <div className="flex flex-col items-start gap-3 rounded-lg border p-4">
          <p className="text-sm text-muted-foreground">
            {file.binary ? strings.skill.binary : strings.skill.tooLarge}
          </p>
          <a href={href} download className={buttonVariants({ variant: 'outline' })}>
            <DownloadIcon aria-hidden />
            {strings.skill.download}
          </a>
        </div>
      ) : content.isError ? (
        <ErrorAlert error={content.error} />
      ) : content.data === undefined ? (
        <Skeleton className="h-40 w-full" aria-label={strings.common.loading} />
      ) : content.data === '' ? (
        <p className="text-sm text-muted-foreground">{strings.skill.emptyFile}</p>
      ) : (
        <pre className="max-h-[70vh] overflow-auto rounded-lg border bg-muted/40 p-3 font-mono text-xs leading-relaxed whitespace-pre-wrap break-words">
          {content.data}
        </pre>
      )}
    </section>
  );
}
