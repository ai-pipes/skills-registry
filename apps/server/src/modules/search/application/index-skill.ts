import { buildPassage, skillBody } from '../domain/search-document.ts';
import type { SearchDeps } from './ports.ts';

/**
 * Brings the search document of `slug` in line with the catalog's latest version.
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
    await deps.index.remove(cmd.slug);
    return;
  }
  let embedding: number[] | null = null;
  let failure: unknown = null;
  try {
    [embedding = null] = await deps.embedder.embedPassages([buildPassage(skill)]);
  } catch (error) {
    failure = error;
  }
  await deps.index.upsert({
    slug: skill.slug,
    name: skill.name,
    description: skill.description,
    version: skill.version,
    body: skillBody(skill.skillMd),
    folder: skill.folder,
    embedding,
  });
  if (failure !== null) throw failure;
}
