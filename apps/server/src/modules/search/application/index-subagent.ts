import type { SearchDeps } from './ports.ts';
import { writeDocument } from './write-document.ts';

/**
 * Brings the search document of subagent `slug` in line with the catalog's latest version
 * (passage: name, description and the prompt body). Archived or missing subagent → the
 * document is removed. Embedder failures behave as in `indexSkill`.
 */
export async function indexSubagent(
  deps: Pick<SearchDeps, 'index' | 'embedder' | 'subagents'>,
  cmd: { slug: string },
): Promise<void> {
  const subagent = await deps.subagents.get(cmd.slug);
  if (!subagent || subagent.status === 'archived') {
    await deps.index.remove('subagent', cmd.slug);
    return;
  }
  await writeDocument(deps, {
    kind: 'subagent',
    slug: subagent.slug,
    name: subagent.name,
    description: subagent.description,
    version: subagent.version,
    body: subagent.body,
    folder: subagent.folder,
  });
}
