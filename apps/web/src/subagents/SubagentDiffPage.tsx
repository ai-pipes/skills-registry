import type { FileDiff } from '@skills/contracts';
import { useParams } from 'react-router';
import { useSubagentDiff } from '@/api/queries.ts';
import { DiffFrame, DiffView, useDiffRange } from '@/history/DiffView.tsx';
import { strings } from '@/strings.ts';

type Tools = string[] | null;

/** Tools gained and lost between two versions; `null` (all tools) counts as one entry. */
function toolChanges(from: Tools, to: Tools): { added: string[]; removed: string[] } {
  const all = strings.history.allTools;
  const was = from ?? [all];
  const now = to ?? [all];
  return {
    added: now.filter((x) => !was.includes(x)),
    removed: was.filter((x) => !now.includes(x)),
  };
}

function PermissionsChanged({ added, removed }: { added: string[]; removed: string[] }) {
  return (
    <section
      aria-label={strings.history.permissionsChanged}
      className="rounded-lg border border-amber-500/50 bg-amber-500/10 p-3"
    >
      <h2 className="mb-2 text-sm font-medium">{strings.history.permissionsChanged}</h2>
      <ul className="flex flex-col gap-1 font-mono text-sm">
        {added.map((tool) => (
          <li key={`+${tool}`}>{`+ ${tool}`}</li>
        ))}
        {removed.map((tool) => (
          <li key={`-${tool}`}>{`- ${tool}`}</li>
        ))}
      </ul>
    </section>
  );
}

/** SUBAGENT.md as one file diff: a null patch means the changes are too large to show. */
function fileDiff(patch: string | null): FileDiff {
  const path = strings.history.subagentFile;
  if (patch === null) return { path, status: 'modified', patch: null, tooLarge: true };
  return { path, status: patch === '' ? 'unchanged' : 'modified', patch };
}

/** `/subagents/:slug/diff?from=&to=`: "Permissions changed" (if any) above the text diff. */
export function SubagentDiffPage() {
  const { slug = '' } = useParams();
  const range = useDiffRange();
  const diff = useSubagentDiff(slug, range?.from ?? 0, range?.to ?? 0, range !== undefined);
  return (
    <DiffFrame
      slug={slug}
      base={`/subagents/${encodeURIComponent(slug)}`}
      range={range}
      result={diff}
    >
      {({ patch, tools }) => {
        const changes = toolChanges(tools.from, tools.to);
        return (
          <>
            {changes.added.length + changes.removed.length > 0 && (
              <PermissionsChanged {...changes} />
            )}
            <DiffView diffs={[fileDiff(patch)]} />
          </>
        );
      }}
    </DiffFrame>
  );
}
