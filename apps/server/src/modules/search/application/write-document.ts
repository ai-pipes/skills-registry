import { buildPassage } from '../domain/search-document.ts';
import type { IndexedDocument, SearchDeps } from './ports.ts';

/**
 * Embeds the document's passage and upserts it. If the embedder fails, the document is still
 * written (FTS works, `embedding = null`) and the error is rethrown so the outbox retries and
 * fills the embedding in later.
 */
export async function writeDocument(
  deps: Pick<SearchDeps, 'index' | 'embedder'>,
  doc: Omit<IndexedDocument, 'embedding'>,
): Promise<void> {
  let embedding: number[] | null = null;
  let failure: unknown = null;
  try {
    [embedding = null] = await deps.embedder.embedPassages([buildPassage(doc)]);
  } catch (error) {
    failure = error;
  }
  await deps.index.upsert({ ...doc, embedding });
  if (failure !== null) throw failure;
}
