import { SkillStatusFilter, type SkillSummary } from '@skills/contracts';
import { LibraryIcon, PlusIcon, SearchIcon, SearchXIcon } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router';
import { useFolders, useSkills } from '@/api/queries.ts';
import { EmptyState } from '@/components/EmptyState.tsx';
import { ErrorAlert } from '@/components/ErrorAlert.tsx';
import { Badge } from '@/components/ui/badge';
import { buttonVariants } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { formatDateTime, formatRelative } from '@/lib/format.ts';
import { strings } from '@/strings.ts';

/** Pause after the last keystroke before the search request goes out. */
const SEARCH_DEBOUNCE_MS = 250;

const STATUSES = SkillStatusFilter.options;

function SkillRow({ skill }: { skill: SkillSummary }) {
  return (
    <li>
      <Link
        to={`/skills/${encodeURIComponent(skill.slug)}`}
        className="flex flex-col gap-1 rounded-lg border p-3 transition-colors hover:bg-muted/50 focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none"
      >
        <span className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
          <span className="font-medium">{skill.name}</span>
          <span className="font-mono text-xs text-muted-foreground">{skill.slug}</span>
          {skill.status === 'archived' && (
            <Badge variant="secondary">{strings.skill.archivedBadge}</Badge>
          )}
        </span>
        <span className="line-clamp-2 text-sm text-muted-foreground">{skill.description}</span>
        <span className="flex gap-3 text-xs text-muted-foreground">
          <span>{skill.folder.name}</span>
          <span>{strings.skills.version(skill.version)}</span>
          <time dateTime={skill.updatedAt} title={formatDateTime(skill.updatedAt)}>
            {formatRelative(skill.updatedAt)}
          </time>
        </span>
      </Link>
    </li>
  );
}

function ListSkeleton() {
  return (
    <div className="flex flex-col gap-2" aria-busy="true" aria-label={strings.common.loading}>
      {[0, 1, 2].map((i) => (
        <Skeleton key={i} className="h-20 w-full" />
      ))}
    </div>
  );
}

/** `/skills`: the list with the status filter and search (`?status=&q=` in the URL). */
export function SkillsListPage() {
  const [params, setParams] = useSearchParams();
  const parsedStatus = SkillStatusFilter.safeParse(params.get('status'));
  const status = parsedStatus.success ? parsedStatus.data : 'active';
  const q = (params.get('q') ?? '').trim();
  const folder = params.get('folder') ?? '';
  const [text, setText] = useState(params.get('q') ?? '');

  // The URL (and so the query) follows the input after a pause, not per keystroke.
  useEffect(() => {
    const id = setTimeout(() => {
      setParams(
        (prev) => {
          const next = new URLSearchParams(prev);
          if (text.trim() === '') next.delete('q');
          else next.set('q', text);
          return next.toString() === prev.toString() ? prev : next;
        },
        { replace: true },
      );
    }, SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(id);
  }, [text, setParams]);

  function onStatus(value: unknown) {
    const parsed = SkillStatusFilter.safeParse(value);
    if (!parsed.success) return;
    setParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        if (parsed.data === 'active') next.delete('status');
        else next.set('status', parsed.data);
        return next;
      },
      { replace: true },
    );
  }

  function onFolder(value: unknown) {
    if (typeof value !== 'string') return;
    setParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        if (value === '') next.delete('folder');
        else next.set('folder', value);
        return next;
      },
      { replace: true },
    );
  }

  // An archived folder from the URL stays selectable; an unknown one shows "All folders".
  const folders = useFolders('all');
  const folderItems = [
    { value: '', label: strings.skills.allFolders },
    ...(folders.data ?? [])
      .filter((f) => f.status === 'active' || f.slug === folder)
      .map((f) => ({
        value: f.slug,
        label:
          f.status === 'archived' ? `${f.name} (${strings.skills.folderArchivedMark})` : f.name,
      })),
  ];
  const selectedFolder = folderItems.some((i) => i.value === folder) ? folder : '';

  const skills = useSkills({ status, q, folder });
  const newSkillHref =
    folder === '' ? '/skills/new' : `/skills/new?folder=${encodeURIComponent(folder)}`;
  const searching = q !== '';

  let body;
  if (skills.isError) {
    body = <ErrorAlert error={skills.error} />;
  } else if (skills.data === undefined) {
    body = <ListSkeleton />;
  } else if (skills.data.length === 0 && searching) {
    body = (
      <EmptyState
        icon={SearchXIcon}
        title={strings.skills.nothingFound}
        description={strings.skills.nothingFoundHint}
      />
    );
  } else if (skills.data.length === 0 && status === 'active') {
    body = (
      <EmptyState
        icon={LibraryIcon}
        title={strings.skills.emptyTitle}
        description={strings.skills.emptyHint}
        action={
          <Link to={newSkillHref} className={buttonVariants()}>
            {strings.skills.emptyCreate}
          </Link>
        }
      />
    );
  } else if (skills.data.length === 0) {
    body = <EmptyState icon={LibraryIcon} title={strings.skills.emptyFilter} />;
  } else {
    body = (
      <ul className="flex flex-col gap-2">
        {skills.data.map((skill) => (
          <SkillRow key={skill.slug} skill={skill} />
        ))}
      </ul>
    );
  }

  return (
    <div className="mx-auto flex w-full max-w-4xl flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h1 className="text-2xl font-semibold">{strings.skills.title}</h1>
        <Link to={newSkillHref} className={buttonVariants()}>
          <PlusIcon aria-hidden />
          {strings.skills.create}
        </Link>
      </div>
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
        <div className="relative flex-1">
          <SearchIcon
            aria-hidden
            className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground"
          />
          <Input
            type="search"
            aria-label={strings.skills.search}
            placeholder={strings.skills.searchPlaceholder}
            className="pl-8"
            value={text}
            maxLength={500}
            onChange={(e) => setText(e.target.value)}
          />
        </div>
        <Select items={folderItems} value={selectedFolder} onValueChange={onFolder}>
          <SelectTrigger aria-label={strings.skills.folderFilter} className="w-full sm:w-48">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {folderItems.map((item) => (
              <SelectItem key={item.value} value={item.value}>
                {item.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Tabs value={status} onValueChange={onStatus}>
          <TabsList aria-label={strings.skills.filter}>
            {STATUSES.map((s) => (
              <TabsTrigger key={s} value={s}>
                {strings.skills.status[s]}
              </TabsTrigger>
            ))}
          </TabsList>
        </Tabs>
      </div>
      {searching && skills.data !== undefined && !skills.isPlaceholderData && (
        <p className="text-sm text-muted-foreground" aria-live="polite">
          {strings.skills.found(skills.data.length)}
        </p>
      )}
      {body}
    </div>
  );
}
