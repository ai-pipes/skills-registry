import { useParams } from 'react-router';
import { useRollbackSubagent, useSubagentHistory } from '@/api/queries.ts';
import { ErrorAlert } from '@/components/ErrorAlert.tsx';
import { HistorySkeleton, VersionHistory } from '@/history/HistoryPage.tsx';
import { strings } from '@/strings.ts';

/** `/subagents/:slug/history`: the same list as for skills, with rollback. */
export function SubagentHistoryPage() {
  const { slug = '' } = useParams();
  const history = useSubagentHistory(slug);
  const rollback = useRollbackSubagent(slug);
  if (history.isError) return <ErrorAlert error={history.error} />;
  if (history.data === undefined) return <HistorySkeleton />;
  return (
    <VersionHistory
      slug={slug}
      base={`/subagents/${encodeURIComponent(slug)}`}
      versions={history.data}
      backLabel={strings.history.backToSubagent}
      conflictText={strings.history.subagentConflict}
      rollback={rollback.mutateAsync}
    />
  );
}
