import type { FolderStatus } from '../../domain/folder.ts';
import type { CatalogDeps } from '../deps.ts';
import type { FolderSummary } from '../ports.ts';

export async function listFolders(
  deps: Pick<CatalogDeps, 'folders'>,
  q: { status: FolderStatus | 'all' },
): Promise<FolderSummary[]> {
  return deps.folders.list(q.status);
}
