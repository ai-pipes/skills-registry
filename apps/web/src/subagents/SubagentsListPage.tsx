import { SkillStatusFilter, type SubagentSummary } from '@skills/contracts';
import { BotIcon, PlusIcon, SearchIcon, SearchXIcon } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router';
import { useFolders, useSubagents } from '@/api/queries.ts';
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

function SubagentRow({ subagent }: { subagent: SubagentSummary }) {
  return (
    <li>
      <Link
        to={`/subagents/${encodeURIComponent(subagent.slug)}`}
        className="flex flex-col gap-1 rounded-lg border p-3 transition-colors hover:bg-muted/50 focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none"
      >
        <span className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
          <span className="font-medium">{subagent.name}</span>
          <span className="font-mono text-xs text-muted-foreground">{subagent.slug}</span>
          {subagent.status === 'archived' && (
            <Badge variant="secondary">{strings.subagent.archivedBadge}</Badge>
          )}
        </span>
        <span className="line-clamp-2 text-sm text-muted-foreground">{subagent.description}</span>
        <span className="flex gap-3 text-xs text-muted-foreground">
          <span>{subagent.folder.name}</span>
          <span>{subagent.model}</span>
          <span>{strings.subagents.version(subagent.version)}</span>
          <time dateTime={subagent.updatedAt} title={formatDateTime(subagent.updatedAt)}>
            {formatRelative(subagent.updatedAt)}
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

/** `/subagents`: the list with the status filter and search (`?status=&q=` in the URL). */
export function SubagentsListPage() {
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
    { value: '', label: strings.subagents.allFolders },
    ...(folders.data ?? [])
      .filter((f) => f.status === 'active' || f.slug === folder)
      .map((f) => ({
        value: f.slug,
        label:
          f.status === 'archived' ? `${f.name} (${strings.subagents.folderArchivedMark})` : f.name,
      })),
  ];
  const selectedFolder = folderItems.some((i) => i.value === folder) ? folder : '';

  const subagents = useSubagents({ status, q, folder });
  const newSubagentHref =
    folder === '' ? '/subagents/new' : `/subagents/new?folder=${encodeURIComponent(folder)}`;
  const searching = q !== '';

  let body;
  if (subagents.isError) {
    body = <ErrorAlert error={subagents.error} />;
  } else if (subagents.data === undefined) {
    body = <ListSkeleton />;
  } else if (subagents.data.length === 0 && searching) {
    body = (
      <EmptyState
        icon={SearchXIcon}
        title={strings.subagents.nothingFound}
        description={strings.subagents.nothingFoundHint}
      />
    );
  } else if (subagents.data.length === 0 && status === 'active') {
    body = (
      <EmptyState
        icon={BotIcon}
        title={strings.subagents.emptyTitle}
        description={strings.subagents.emptyHint}
        action={
          <Link to={newSubagentHref} className={buttonVariants()}>
            {strings.subagents.emptyCreate}
          </Link>
        }
      />
    );
  } else if (subagents.data.length === 0) {
    body = <EmptyState icon={BotIcon} title={strings.subagents.emptyFilter} />;
  } else {
    body = (
      <ul className="flex flex-col gap-2">
        {subagents.data.map((subagent) => (
          <SubagentRow key={subagent.slug} subagent={subagent} />
        ))}
      </ul>
    );
  }

  return (
    <div className="mx-auto flex w-full max-w-4xl flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h1 className="text-2xl font-semibold">{strings.subagents.title}</h1>
        <Link to={newSubagentHref} className={buttonVariants()}>
          <PlusIcon aria-hidden />
          {strings.subagents.create}
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
            aria-label={strings.subagents.search}
            placeholder={strings.subagents.searchPlaceholder}
            className="pl-8"
            value={text}
            maxLength={500}
            onChange={(e) => setText(e.target.value)}
          />
        </div>
        <Select items={folderItems} value={selectedFolder} onValueChange={onFolder}>
          <SelectTrigger aria-label={strings.subagents.folderFilter} className="w-full sm:w-48">
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
          <TabsList aria-label={strings.subagents.filter}>
            {STATUSES.map((s) => (
              <TabsTrigger key={s} value={s}>
                {strings.subagents.status[s]}
              </TabsTrigger>
            ))}
          </TabsList>
        </Tabs>
      </div>
      {searching && subagents.data !== undefined && !subagents.isPlaceholderData && (
        <p className="text-sm text-muted-foreground" aria-live="polite">
          {strings.subagents.found(subagents.data.length)}
        </p>
      )}
      {body}
    </div>
  );
}
