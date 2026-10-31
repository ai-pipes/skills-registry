import { documentBody } from '../domain/search-document.ts';
import type { SearchDeps } from './ports.ts';
import { writeDocument } from './write-document.ts';

/**
 * Brings the search document of skill `slug` in line with the catalog's latest version.
 * Archived or missing skill → the document is removed.
 * If the embedder fails, the document is still written (FTS works, `embedding = null`)
 * and the error is rethrown so the outbox retries and fills the embedding in later.
 */
export async function indexSkill(
  deps: Pick<SearchDeps, 'index' | 'embedder' | 'skills'>,
  cmd: { slug: string },
): Promise<void> {
  const skill = await deps.skills.get(cmd.slug);
  if (!skill || skill.status === 'archived') {
    await deps.index.remove('skill', cmd.slug);
    return;
  }
  await writeDocument(deps, {
    kind: 'skill',
    slug: skill.slug,
    name: skill.name,
    description: skill.description,
    version: skill.version,
    body: documentBody(skill.skillMd),
    folder: skill.folder,
  });
}
