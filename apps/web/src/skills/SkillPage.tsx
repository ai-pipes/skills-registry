import { useState } from 'react';
import { FolderInputIcon, HistoryIcon, PencilIcon } from 'lucide-react';
import type { SkillSource } from '@skills/contracts';
import { Link, useParams, useSearchParams } from 'react-router';
import { isApiError } from '@/api/errors.ts';
import { useSkill } from '@/api/queries.ts';
import { EmptyState } from '@/components/EmptyState.tsx';
import { ErrorAlert } from '@/components/ErrorAlert.tsx';
import { PageSkeleton } from '@/components/PageSkeleton.tsx';
import { Badge } from '@/components/ui/badge';
import { Button, buttonVariants } from '@/components/ui/button';
import { withoutFrontMatter } from '@/lib/frontMatter.ts';
import { formatDateTime, formatRelative } from '@/lib/format.ts';
import { parseVersion } from '@/lib/versionParam.ts';
import { strings } from '@/strings.ts';
import { ArchiveButton } from './ArchiveButton.tsx';
import { FileTree } from './FileTree.tsx';
import { FileView } from './FileView.tsx';
import { Markdown } from './Markdown.tsx';
import { MoveSkillDialog } from './MoveSkillDialog.tsx';
import { githubUrl, shortSha, sourceLabel } from './source.ts';

const SKILL_MD = 'SKILL.md';

/** "Imported from owner/repo/path @ sha7": a GitHub link only when the source is safe to link. */
function SourceLine({ source, commit }: { source: SkillSource; commit: string | null }) {
  const label = sourceLabel(source);
  const text = commit === null ? label : strings.skill.sourceAt(label, shortSha(commit));
  const href = commit === null ? null : githubUrl(source, commit);
  return (
    <p className="text-sm text-muted-foreground">
      {strings.skill.importedFrom}
      {href === null ? (
        <span className="font-mono break-all">{text}</span>
      ) : (
        <a
          href={href}
          target="_blank"
          rel="noopener noreferrer"
          className="font-mono break-all underline underline-offset-2"
        >
          {text}
        </a>
      )}
    </p>
  );
}

/**
 * `/skills/:slug[?version=N][&file=path]`: header with actions, rendered SKILL.md, the file
 * tree; a picked file opens in `FileView`. `updatedAt` is the skill's, even for `?version=N`.
 */
export function SkillPage() {
  const { slug = '' } = useParams();
  const [params, setParams] = useSearchParams();
  const version = parseVersion(params.get('version'));
  const skill = useSkill(slug, version);
  const [moving, setMoving] = useState(false);

  if (skill.isError) {
    const code = isApiError(skill.error) ? skill.error.code : undefined;
    if (code === 'skill_not_found') {
      return <EmptyState title={strings.skill.notFound} description={strings.skill.notFoundHint} />;
    }
    if (code === 'version_not_found') return <EmptyState title={strings.skill.versionNotFound} />;
    return <ErrorAlert error={skill.error} />;
  }
  if (skill.data === undefined) return <PageSkeleton />;

  const data = skill.data;
  const archived = data.status === 'archived';
  const requested = params.get('file');
  const openFile =
    requested !== null && requested !== SKILL_MD
      ? data.files.find((f) => f.path === requested)
      : undefined;
  const base = `/skills/${encodeURIComponent(data.slug)}`;

  function select(path: string) {
    setParams((prev) => {
      const next = new URLSearchParams(prev);
      if (path === SKILL_MD) next.delete('file');
      else next.set('file', path);
      return next;
    });
  }

  return (
    <div className="mx-auto flex w-full max-w-6xl flex-col gap-6">
      <header className="flex flex-col gap-3">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="flex min-w-0 flex-col gap-1">
            <div className="flex flex-wrap items-center gap-2">
              <h1 className="text-2xl font-semibold break-words">{data.name}</h1>
              {archived && <Badge variant="secondary">{strings.skill.archivedBadge}</Badge>}
            </div>
            <p className="flex flex-wrap gap-x-3 text-sm text-muted-foreground">
              <Link
                to={`/skills?folder=${encodeURIComponent(data.folder.slug)}${archived ? '&status=archived' : ''}`}
                className="underline-offset-2 hover:underline"
              >
                {data.folder.name}
              </Link>
              <span className="font-mono">{data.slug}</span>
              <span>{strings.skill.version(data.version)}</span>
              <time dateTime={data.updatedAt} title={formatDateTime(data.updatedAt)}>
                {strings.skill.updated(formatRelative(data.updatedAt))}
              </time>
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            {!archived && (
              <Link to={`${base}/edit`} className={buttonVariants({ variant: 'outline' })}>
                <PencilIcon aria-hidden />
                {strings.skill.edit}
              </Link>
            )}
            <Link to={`${base}/history`} className={buttonVariants({ variant: 'outline' })}>
              <HistoryIcon aria-hidden />
              {strings.skill.history}
            </Link>
            {!archived && (
              <Button variant="outline" onClick={() => setMoving(true)}>
                <FolderInputIcon aria-hidden />
                {strings.skill.move}
              </Button>
            )}
            <ArchiveButton slug={data.slug} archived={archived} folder={data.folder} />
          </div>
        </div>
        {data.source !== null && <SourceLine source={data.source} commit={data.sourceCommit} />}
        {data.description && <p className="text-muted-foreground">{data.description}</p>}
        {data.usedBy.length > 0 && (
          <p className="flex flex-wrap gap-x-2 text-sm text-muted-foreground">
            <span>{strings.skill.usedBy}</span>
            {data.usedBy.map((name) => (
              <Link
                key={name}
                to={`/subagents/${encodeURIComponent(name)}`}
                className="underline underline-offset-2"
              >
                {name}
              </Link>
            ))}
          </p>
        )}
      </header>
      {!archived && moving && (
        <MoveSkillDialog
          slug={data.slug}
          current={data.folder}
          open={moving}
          onOpenChange={setMoving}
        />
      )}
      <div className="grid gap-6 md:grid-cols-[minmax(12rem,16rem)_minmax(0,1fr)]">
        <aside className="min-w-0 md:border-r md:pr-4">
          <h2 className="mb-2 text-sm font-medium">{strings.skill.files}</h2>
          <FileTree files={data.files} selected={openFile?.path ?? SKILL_MD} onSelect={select} />
        </aside>
        <div className="min-w-0">
          {openFile ? (
            <FileView key={openFile.path} slug={data.slug} file={openFile} version={version} />
          ) : (
            <Markdown
              slug={data.slug}
              version={version}
              source={withoutFrontMatter(data.skillMd)}
            />
          )}
        </div>
      </div>
    </div>
  );
}
